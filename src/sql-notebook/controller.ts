import {
  ExtensionContext, NotebookCell, NotebookCellOutput, NotebookCellOutputItem, NotebookController,
  NotebookDocument, NotebookEdit, notebooks, window, workspace, WorkspaceEdit,
} from "vscode";
import { BatchResult, Driver } from "../shared/driver";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config";
import { logger } from "../logger/logger";
import { renderRowsAsMarkdown, rowsToResultTable } from "../shared/notebook-render";
import { describePosition } from "../shared/statement-position";

export const FIREBIRD_NOTEBOOK_TYPE = "firebird-notebook";
const CONTROLLER_ID = "firebird-sql-notebook-controller";

/** Custom mime type the notebook renderer (src/sql-notebook/renderer/, docs/roadmap/sql-notebooks.md phase 2) is registered for in package.json's contributes.notebookRenderer. */
export const RESULT_TABLE_MIME = "application/x-firebird-notebook-result+json";

/**
 * notebook.uri -> the connection its cells run against, resolved (password included) for the
 * current session. The connection *id* is also persisted into the .fbnb file's own metadata (see
 * serializer.ts) so reopening the notebook doesn't re-prompt — but the resolved password never
 * is, so this in-memory cache is still needed every session: it's what resolveNotebookConnection()
 * checks first, and it's what actually carries the password once resolved.
 */
const boundConnections = new Map<string, ConnectionOptions>();

/** Drops a notebook's remembered connection (and the password it carries) once the notebook closes. */
export function forgetNotebookConnection(notebook: NotebookDocument): void {
  boundConnections.delete(notebook.uri.toString());
}

/**
 * Synchronises an externally chosen connection into the notebook's bound-connections map so that
 * the next cell execution uses the new connection without re-prompting.  Called by Global's
 * `activeConnection` setter (lazily required to avoid a circular-import chain).
 */
export function syncNotebookConnection(notebookUri: string, conn: ConnectionOptions): void {
  boundConnections.set(notebookUri, conn);
}

let executionOrder = 0;

export function createSqlNotebookController(context: ExtensionContext): NotebookController {
  const controller = notebooks.createNotebookController(CONTROLLER_ID, FIREBIRD_NOTEBOOK_TYPE, "Firebird SQL");
  controller.supportedLanguages = ["sql"];
  controller.supportsExecutionOrder = true;
  controller.executeHandler = (cells, notebook) => executeCells(cells, notebook, context, controller);
  return controller;
}

async function executeCells(
  cells: NotebookCell[], notebook: NotebookDocument, context: ExtensionContext, controller: NotebookController
): Promise<void> {
  for (const cell of cells) {
    await executeCell(cell, notebook, context, controller);
  }
}

async function executeCell(
  cell: NotebookCell, notebook: NotebookDocument, context: ExtensionContext, controller: NotebookController
): Promise<void> {
  const execution = controller.createNotebookCellExecution(cell);
  execution.executionOrder = ++executionOrder;
  execution.start(Date.now());

  try {
    const connectionOptions = await resolveNotebookConnection(notebook, context);
    if (!connectionOptions) {
      await execution.replaceOutput(new NotebookCellOutput([
        NotebookCellOutputItem.text("No connection selected — cell not run.", "text/plain"),
      ]));
      execution.end(false, Date.now());
      return;
    }

    const results = await Driver.runBatch(cell.document.getText(), connectionOptions);
    await execution.replaceOutput(results.map(r => new NotebookCellOutput(resultToOutputItems(r))));
    execution.end(!results.some(r => r.error), Date.now());
  } catch (err: any) {
    logger.error(`Notebook cell execution failed: ${err?.message ?? err}`);
    await execution.replaceOutput(new NotebookCellOutput([
      NotebookCellOutputItem.error(err instanceof Error ? err : new Error(String(err?.message ?? err))),
    ]));
    execution.end(false, Date.now());
  }
}

/**
 * A row-bearing result gets two output items, richest-first: the custom grid renderer
 * (sort/filter/paginate/copy — see src/sql-notebook/renderer/) as the primary mime, and the
 * plain markdown table VS Code already renders natively as a fallback for the (unlikely, since
 * this extension ships the renderer itself) case the custom renderer fails to load. Error/message
 * outputs are unchanged from phase 1 — there's no "richer" way to show those.
 *
 * Exported for testing (src/test/suite/) — needs the real NotebookCellOutputItem class, so it's
 * only meaningfully testable at the vscode-host tier, same as resolveNotebookConnection() below.
 */
export function resultToOutputItems(result: BatchResult): NotebookCellOutputItem[] {
  if (result.error) {
    // A cell holding several statements has the same "which one broke?" problem a .sql script
    // does, and the same answer — the position is counted within the cell, which is exactly the
    // unit the user is looking at. Suppressed when it points at the very start of the cell, where
    // it would only restate that the cell failed.
    const at = result.errorPosition;
    const prefix = at && (at.line > 1 || at.column > 1) ? `${describePosition(at)}: ` : "";
    const errorMsg = `${prefix}${result.error}`;
    return [
      NotebookCellOutputItem.error(new Error(errorMsg)),
      NotebookCellOutputItem.text(`Error: ${errorMsg}`, "text/plain"),
    ];
  }
  if (result.rows) {
    return [
      NotebookCellOutputItem.json(rowsToResultTable(result.rows), RESULT_TABLE_MIME),
      NotebookCellOutputItem.text(renderRowsAsMarkdown(result.rows), "text/markdown"),
    ];
  }
  return [NotebookCellOutputItem.text(result.message ?? "Statement executed successfully.", "text/plain")];
}

/** Exported for testing (src/test/suite/) — not called from outside this module otherwise. */
export async function resolveNotebookConnection(
  notebook: NotebookDocument, context: ExtensionContext
): Promise<ConnectionOptions | undefined> {
  const key = notebook.uri.toString();
  const existing = boundConnections.get(key);
  if (existing) {
    return existing;
  }

  const connections = context.globalState.get<Record<string, ConnectionOptions>>(Constants.ConectionsKey, {});

  // Persisted binding from a previous session (serializer.ts round-trips this through the .fbnb
  // file's own metadata) — use it without prompting if the connection it names still exists.
  // Falls through to the picker below if it's gone (e.g. the connection was since removed).
  const persistedId = notebook.metadata?.connectionId;
  if (typeof persistedId === "string" && connections[persistedId]) {
    const resolved = await Driver.resolvePassword(connections[persistedId]);
    boundConnections.set(key, resolved);
    return resolved;
  }

  const items = Object.values(connections).map(c => ({
    label: c.embedded ? `[embedded] ${c.database}` : `${c.host}: ${c.database}`,
    detail: c.id,
    conn: c,
  }));
  if (items.length === 0) {
    logger.showError("No saved connections found. Add a connection before running a notebook cell.");
    return undefined;
  }

  const picked = await window.showQuickPick(items, { placeHolder: "Select a connection for this notebook" });
  if (!picked) {
    return undefined;
  }

  const resolved = await Driver.resolvePassword(picked.conn);
  boundConnections.set(key, resolved);
  await persistNotebookConnectionId(notebook, picked.conn.id);
  return resolved;
}

/** Writes the chosen connection's id into the notebook's own metadata so reopening it (or a VS Code restart) doesn't re-prompt — see serializer.ts's FbnbMetadata. Never the password itself, only the id; the password is re-resolved via CredentialStore each session. */
async function persistNotebookConnectionId(notebook: NotebookDocument, connectionId: string): Promise<void> {
  const edit = new WorkspaceEdit();
  edit.set(notebook.uri, [NotebookEdit.updateNotebookMetadata({ ...notebook.metadata, connectionId })]);
  await workspace.applyEdit(edit);
}

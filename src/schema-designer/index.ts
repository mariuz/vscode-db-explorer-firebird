import * as vscode from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver, BatchResult } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery, getAllPrimaryKeyConstraintNamesQuery } from "../shared/queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "./schema-graph";
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas } from "../shared/schema-support";
import { extractJson } from "../copilot/json-extraction";
import { logger } from "../logger/logger";

/**
 * Webview merging the former read-only Schema Visualizer and single-table Table Designer into
 * one multi-table entity-relationship editor: view the whole database's tables/relationships,
 * add new tables/columns/foreign keys, and alter existing tables' columns and primary key —
 * always loading the full schema graph regardless of entry point (Firebird schemas here are
 * modest in size, and the visualizer this replaces already always loaded everything in one go).
 */
export class SchemaDesigner extends QueryResultsView implements vscode.Disposable {
  private dbDetails?: ConnectionOptions;
  /**
   * The webview can't reliably receive a postMessage() sent immediately after show() — its
   * script may not have run yet. It posts a "ready" message once loaded; until then, what to
   * focus once the schema loads is held here and flushed from handleMessage() on "ready".
   */
  private pendingInit: Message | undefined;
  /** Cancels a stale "Ask Copilot" request if a new one comes in (or the panel closes) before it resolves. */
  private copilotRequestCts?: vscode.CancellationTokenSource;

  constructor(private readonly extensionPath: string) {
    super("schemadesigner", "Firebird Schema Designer");
  }

  /** Opens the designer showing the whole schema — was SchemaVisualizer.open(). */
  openFullSchema(dbDetails: ConnectionOptions): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: {} };
    this.showDesigner();
  }

  /** Opens the designer with a blank new table seeded and focused — was TableDesigner.open(). */
  openNewTable(dbDetails: ConnectionOptions): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: { addNewTable: true } };
    this.showDesigner();
  }

  /** Opens the designer with an existing table focused — was TableDesigner.openForAlter(). */
  openForAlterTable(dbDetails: ConnectionOptions, tableName: string): void {
    this.dbDetails = dbDetails;
    this.pendingInit = { command: "init", data: { focusTable: tableName } };
    this.showDesigner();
  }

  private showDesigner(): void {
    super.show(join(this.extensionPath, "src", "schema-designer", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    const { command, data } = message as Message & { data: { ddl?: string; instruction?: string; schemaSummary?: string } };
    if (command === "ready") {
      if (this.pendingInit) {
        this.send(this.pendingInit);
        this.pendingInit = undefined;
      }
      return;
    }
    if (command === "getData" || command === "refresh") {
      this.fetchAndSend().catch(err => logger.error(err));
      return;
    }
    if (command === "openInEditor") {
      Driver.createSQLTextDocument(data.ddl ?? "").catch(err => logger.error(err));
      return;
    }
    if (command === "executeDDL") {
      this.executeDDL(data.ddl ?? "");
      return;
    }
    if (command === "askCopilot") {
      this.handleAskCopilot(data.instruction ?? "", data.schemaSummary ?? "").catch(err => logger.error(err));
    }
  }

  dispose(): void {
    this.copilotRequestCts?.cancel();
    super.dispose();
  }

  /**
   * Sends the user's free-text schema-change request, plus a plain-text summary of the current
   * draft (tables/columns/relationships, including ones added this session but not yet in the
   * database), to the language model. Deliberately asks for a small structured JSON edit
   * (add/modify/remove tables, columns, relationships) rather than raw DDL: the webview already
   * has a proven, rename-safe diff engine that turns draft-state edits into correct ALTER/CREATE
   * statements (see buildDDL() in htmlContent/js/app.js) — applying the model's response as
   * ordinary draft edits reuses that entirely, rather than asking the model to get Firebird DDL
   * syntax and statement ordering right itself.
   */
  private async handleAskCopilot(instruction: string, schemaSummary: string): Promise<void> {
    this.copilotRequestCts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.copilotRequestCts = cts;

    if (!instruction.trim()) {
      this.send({ command: "copilotSchemaEdit", data: { error: "Describe the schema change you'd like." } });
      return;
    }

    try {
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      const model = models[0];
      if (!model) {
        this.send({
          command: "copilotSchemaEdit",
          data: { error: "No Copilot language model is available. Make sure GitHub Copilot Chat is installed and signed in." }
        });
        return;
      }

      const messages = [
        vscode.LanguageModelChatMessage.User(copilotSystemPrompt(schemaSummary, instruction))
      ];
      const response = await model.sendRequest(messages, {}, cts.token);
      let text = "";
      for await (const fragment of response.text) {
        text += fragment;
      }

      let edit: unknown;
      try {
        edit = JSON.parse(extractJson(text));
      } catch {
        throw new Error(`Copilot didn't return valid JSON. Raw response:\n${text.slice(0, 500)}`);
      }
      this.send({ command: "copilotSchemaEdit", data: { edit } });
    } catch (err: any) {
      if (err instanceof vscode.CancellationError) {
        return;
      }
      const message = err?.message ?? String(err);
      logger.error(`Schema Designer Copilot edit failed: ${message}`);
      this.send({ command: "copilotSchemaEdit", data: { error: message } });
    }
  }

  private async fetchAndSend(): Promise<void> {
    if (!this.dbDetails) {
      this.send({ command: "schemaData", data: { error: "No active database connection." } });
      return;
    }
    try {
      // Firebird 6 keeps every object in a schema, and the graph is keyed by table name — so
      // without asking for the schema, SALES.ORDERS and PUBLIC.ORDERS merge into one box holding
      // the union of their columns. Asking a pre-6 server for the column is a hard SQL error, so
      // the flag comes from the cached version probe.
      const withSchemas = supportsSchemas(
        await getEngineMajorVersion(this.dbDetails.id, async sql => {
          const [row] = await Driver.runBatch(sql, this.dbDetails!);
          return (row?.rows ?? []) as any[];
        })
      );

      // Three SELECTs over one connection (runBatch also resolves the connection's stored
      // password automatically, the same as every other Driver-backed query in the extension).
      const sql = `${getSchemaColumnsQuery(withSchemas)}\n${getForeignKeysQuery(withSchemas)}\n${getAllPrimaryKeyConstraintNamesQuery()}`;
      const results = await Driver.runBatch(sql, this.dbDetails);
      const [columnsResult, fkResult, pkResult] = results;
      if (columnsResult?.error) {
        throw new Error(columnsResult.error);
      }
      if (fkResult?.error) {
        throw new Error(fkResult.error);
      }
      if (pkResult?.error) {
        throw new Error(pkResult.error);
      }

      const graph = buildSchemaGraph(
        (columnsResult?.rows ?? []) as SchemaColumnRow[],
        (fkResult?.rows ?? []) as ForeignKeyRow[]
      );
      const pkConstraintNames: Record<string, string> = {};
      for (const row of (pkResult?.rows ?? []) as { TABLE_NAME: string; CONSTRAINT_NAME: string }[]) {
        pkConstraintNames[row.TABLE_NAME] = row.CONSTRAINT_NAME;
      }
      this.send({ command: "schemaData", data: { graph, pkConstraintNames } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Schema Designer fetch failed: ${message}`);
      this.send({ command: "schemaData", data: { error: message } });
    }
  }

  /**
   * Runs the generated DDL via Driver.runBatch() — not runQuery() — since it's routinely
   * multi-statement once more than one table is touched, and node-firebird's wire protocol only
   * prepares/executes one statement at a time.
   */
  private executeDDL(ddl: string): void {
    if (!this.dbDetails) {
      this.send({ command: "result", data: { text: "No active database connection." } });
      return;
    }
    Driver.runBatch(ddl, this.dbDetails)
      .then(results => {
        this.send({ command: "result", data: { text: summarizeBatchResults(results) } });
      })
      .catch(err => {
        const text = err?.message ?? String(err);
        logger.error(text);
        this.send({ command: "result", data: { text: `Error: ${text}` } });
      });
  }
}

/** One line per failed statement, plus a succeeded/failed count — shown in the webview's result panel. */
function summarizeBatchResults(results: BatchResult[]): string {
  const failed = results.filter(r => r.error);
  const lines = [`${results.length - failed.length} of ${results.length} statement(s) succeeded.`];
  failed.forEach(r => {
    const trimmed = r.sql.trim();
    const snippet = trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
    lines.push(`  ERROR (${snippet}): ${r.error}`);
  });
  return lines.join("\n");
}

/** The JSON edit schema the model is asked to return — see handleAskCopilot()'s doc comment. */
function copilotSystemPrompt(schemaSummary: string, instruction: string): string {
  return [
    "You are a Firebird database schema design assistant integrated into a visual schema designer.",
    "The user is editing a database schema on a canvas and has asked you to make a change.",
    "",
    "Respond with ONLY a JSON object — no markdown code fences, no text outside the JSON — matching exactly this shape:",
    "",
    "{",
    '  "tables": [',
    "    {",
    '      "name": "TABLE_NAME",',
    '      "action": "add" | "modify",',
    '      "columns": [',
    '        { "name": "COLUMN_NAME", "action": "add" | "modify" | "remove", "type": "VARCHAR" | "CHAR" | "INTEGER" | "SMALLINT" | "INT64" | "FLOAT" | "DOUBLE" | "DATE" | "TIME" | "TIMESTAMP" | "BLOB" | "BOOLEAN", "length": 0, "notNull": false, "isPrimaryKey": false, "dflt": null }',
    "      ]",
    "    }",
    "  ],",
    '  "relationships": [',
    '    { "action": "add" | "remove", "fromTable": "TABLE_NAME", "fromColumn": "COLUMN_NAME", "toTable": "TABLE_NAME", "toColumn": "COLUMN_NAME" }',
    "  ],",
    '  "explanation": "One or two sentences describing what you changed and why."',
    "}",
    "",
    "Rules:",
    '- Only include tables/columns/relationships that are actually being added, modified, or removed — omit anything unchanged.',
    '- "modify" on a column changes its type/length/notNull/isPrimaryKey/dflt; include only the fields that should change, plus "name" and "action".',
    "- Use uppercase identifiers, consistent with Firebird's default identifier casing.",
    '- "length" only matters for VARCHAR/CHAR — omit or set to 0 for other types.',
    "- Never reference a table/column that doesn't exist in the current schema below or in a table you're adding in this same response.",
    '- If the request doesn\'t require any schema change (e.g. it\'s a question), return empty "tables"/"relationships" arrays and put your answer in "explanation".',
    "",
    "Current schema:",
    schemaSummary,
    "",
    "Requested change:",
    instruction,
  ].join("\n");
}

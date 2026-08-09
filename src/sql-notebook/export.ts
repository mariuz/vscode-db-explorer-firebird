import { Disposable, notebooks, window, workspace } from "vscode";
import { logger } from "../logger/logger";
import { resultTableToCsv, resultTableToJson, resultTableToExcel } from "../shared/notebook-render";

/**
 * SQL Notebook result export (docs/roadmap/sql-notebooks.md, phase 4).
 *
 * A notebook renderer runs in a sandboxed iframe where triggering a file download isn't reliable —
 * which is why phase 2 stopped at clipboard-only "Copy as CSV"/"Copy as JSON". That reasoning ruled
 * out a *renderer-side* download, not export as such: the renderer posts its rows to the extension
 * host through `notebooks.createRendererMessaging()`, and the host, which can show a save dialog
 * and write files, does the rest.
 *
 * Note this is **not** shared with `src/result-view/`'s export, despite that offering the same
 * formats: that one is entirely client-side (DataTables' own `csv`/`excel`/`pdf` Buttons plus
 * `$.fn.dataTable.fileSave`) inside a full webview, with no extension-host code involved at all, so
 * there was nothing there to reuse. XLSX/PDF are deliberately not offered here for the same reason
 * — those come from libraries vendored into that webview, and pulling a spreadsheet/PDF writer into
 * the extension host just for this would be a large dependency for a small feature.
 */

/** The message `resultRenderer.js`'s Export button posts. */
interface ExportResultMessage {
  type: "exportResult";
  headers: string[];
  rows: (string | null)[][];
  /** True when the renderer only ever received the first `NOTEBOOK_RESULT_ROW_CAP` rows of a larger result. */
  truncated?: boolean;
  totalRowCount?: number;
}

const RENDERER_ID = "firebird-result-renderer";

function isExportResultMessage(message: any): message is ExportResultMessage {
  return !!message
    && message.type === "exportResult"
    && Array.isArray(message.headers)
    && Array.isArray(message.rows);
}

/** Exposed for tests: turns a message into the file contents, without touching any dialog or disk. */
export function serializeExport(message: ExportResultMessage, format: "csv" | "json" | "excel"): string {
  if (format === "csv") {
    return resultTableToCsv(message.headers, message.rows);
  }
  if (format === "json") {
    return resultTableToJson(message.headers, message.rows);
  }
  return resultTableToExcel(message.headers, message.rows);
}

/**
 * Registers the renderer messaging channel that backs the Export button.
 *
 * Returns a disposable even when the API is unavailable, so callers don't have to special-case it —
 * the renderer hides its own Export button when no messaging channel exists.
 */
export function registerNotebookResultExport(): Disposable {
  if (typeof notebooks?.createRendererMessaging !== "function") {
    logger.debug("Notebook renderer messaging is unavailable — result export is disabled.");
    return new Disposable(() => { /* nothing to dispose */ });
  }

  const messaging = notebooks.createRendererMessaging(RENDERER_ID);
  return messaging.onDidReceiveMessage(async event => {
    if (!isExportResultMessage(event.message)) {
      return;
    }
    try {
      await exportResult(event.message);
    } catch (err: any) {
      logger.error(`Notebook result export failed: ${err?.message ?? err}`);
      logger.showError(`Could not export the result: ${err?.message ?? err}`);
    }
  });
}

async function exportResult(message: ExportResultMessage): Promise<void> {
  if (message.rows.length === 0) {
    logger.showError("There are no rows to export.");
    return;
  }

  const format = await window.showQuickPick(
    [
      { label: "CSV", description: "Comma-separated values (.csv)", format: "csv" as const },
      { label: "Excel", description: "Excel spreadsheet (.xlsx / .tsv)", format: "excel" as const },
      { label: "JSON", description: "One object per row (.json)", format: "json" as const },
    ],
    { placeHolder: `Export ${message.rows.length} row(s) as…` }
  );
  if (!format) { return; }

  const filtersMap: Record<string, Record<string, string[]>> = {
    csv: { "CSV": ["csv"], "All files": ["*"] },
    excel: { "Excel Spreadsheet": ["xlsx", "xls", "tsv"], "All files": ["*"] },
    json: { "JSON": ["json"], "All files": ["*"] },
  };

  const target = await window.showSaveDialog({
    title: "Export Query Result",
    filters: filtersMap[format.format],
  });
  if (!target) { return; }

  await workspace.fs.writeFile(target, Buffer.from(serializeExport(message, format.format), "utf8"));

  // Said plainly rather than silently: the renderer is only ever handed the first
  // NOTEBOOK_RESULT_ROW_CAP rows of a larger result, so this export is of what was on screen. The
  // alternative — re-running the cell's SQL to get the full set — would silently execute a query
  // the user didn't ask to run again, which is worse than an accurate message.
  const exported = `Exported ${message.rows.length} row(s) to ${target.fsPath}`;
  if (message.truncated && message.totalRowCount) {
    logger.showInfo(`${exported}. Note: the result was capped at ${message.rows.length} of ${message.totalRowCount} rows when it was displayed, so only those were exported.`);
  } else {
    logger.showInfo(exported);
  }
  logger.info(exported);
}

/** Exposed for the suite test, which asserts this matches the id the contribution declares. */
export const NOTEBOOK_RENDERER_ID = RENDERER_ID;
export type { ExportResultMessage };

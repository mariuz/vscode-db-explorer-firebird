/**
 * Pure cell-output rendering for SQL Notebooks (Phase 1: plain markdown, no vscode dependency —
 * see docs/roadmap/sql-notebooks.md). A GitHub-flavored markdown table renders natively in VS
 * Code's built-in notebook output view (mime type "text/markdown"), so this needs no custom
 * notebook renderer yet; that's Phase 2's "swap in the custom renderer" step.
 */

function escapeMarkdownCell(value: any): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Converts a query's result rows into a markdown table, truncated to maxRows for very large result sets. */
export function renderRowsAsMarkdown(rows: any[], maxRows = 500): string {
  if (!rows || rows.length === 0) {
    return "_0 rows returned._";
  }

  const headers = Object.keys(rows[0]);
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.slice(0, maxRows).map(row => `| ${headers.map(h => escapeMarkdownCell(row[h])).join(" | ")} |`);
  const truncationNote = rows.length > maxRows
    ? `\n\n_...${rows.length - maxRows} more row(s) not shown._`
    : "";

  return [headerLine, separatorLine, ...bodyLines].join("\n") + truncationNote;
}

/**
 * Same rendering as renderRowsAsMarkdown(), but for data that's already shaped as a header list +
 * array-of-string-arrays rather than an array of field->value objects — the shape the results
 * webview already has in hand (src/result-view/htmlContent/js/app.js's tableHeader/tableBody),
 * used by the "AI analysis of query results" action so it doesn't need a second round trip to the
 * database to re-fetch what's already rendered on screen.
 */
export function renderTableAsMarkdown(headers: string[], rows: string[][], maxRows = 50): string {
  if (!rows || rows.length === 0) {
    return "_0 rows returned._";
  }

  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.slice(0, maxRows).map(row => `| ${row.map(escapeMarkdownCell).join(" | ")} |`);
  const truncationNote = rows.length > maxRows
    ? `\n\n_...${rows.length - maxRows} more row(s) not shown._`
    : "";

  return [headerLine, separatorLine, ...bodyLines].join("\n") + truncationNote;
}

// ── Rich JSON shaping for the custom notebook renderer (Phase 2) ───────────────
//
// renderRowsAsMarkdown() above stays as-is for the plain-text fallback mime; this is the shape
// fed to the custom "application/x-firebird-notebook-result+json" renderer instead, which sorts/
// filters/paginates client-side rather than rendering one flat scroll — so it can afford a
// higher row cap than the markdown path's.

/** Higher than renderRowsAsMarkdown()'s default cap since the rich renderer paginates/filters client-side rather than rendering one flat scroll. Cell outputs aren't persisted to the .fbnb file (see serializer.ts), so this only bounds in-memory/webview cost for one session, not on-disk size. */
export const NOTEBOOK_RESULT_ROW_CAP = 1000;

export interface NotebookResultTable {
  headers: string[];
  /** Each cell is a display string, or `null` for a genuine SQL NULL — kept distinct from an empty string so the renderer can style/export them differently. */
  rows: (string | null)[][];
  /** True when `rows` was truncated to maxRows; the renderer surfaces this rather than silently dropping rows. */
  truncated: boolean;
  /** The untruncated row count, for the "showing X of Y" message. */
  totalRowCount: number;
}

/** Converts query result rows (array of field->value objects, as returned by node-firebird) into the shape the custom notebook renderer consumes. */
export function rowsToResultTable(rows: any[], maxRows = NOTEBOOK_RESULT_ROW_CAP): NotebookResultTable {
  if (!rows || rows.length === 0) {
    return { headers: [], rows: [], truncated: false, totalRowCount: 0 };
  }

  const headers = Object.keys(rows[0]);
  const body = rows.slice(0, maxRows).map(row => headers.map(h => cellToDisplayValue(row[h])));
  return { headers, rows: body, truncated: rows.length > maxRows, totalRowCount: rows.length };
}

/**
 * Result export (docs/roadmap/sql-notebooks.md, phase 4) — serializing a notebook result for
 * writing to a file from the *extension host*.
 *
 * These deliberately mirror `resultRenderer.js`'s own `toCsv()`/`toJson()`, which serve its
 * clipboard buttons. Two implementations rather than one shared module is a real constraint, not an
 * oversight: `src/test/sql-notebook-renderer.test.ts` loads the renderer's raw `.js` source through
 * Node's own `import()`, so that file cannot import a `.ts` module without breaking its unit tests,
 * and the renderer bundle is browser-targeted ESM while this is Node CommonJS. The two are instead
 * pinned together by a drift test that runs the same table through both and asserts identical
 * output — see `sql-notebook-renderer.test.ts`.
 *
 * A `null` cell (a genuine SQL NULL, kept distinct from an empty string by `rowsToResultTable()`)
 * serializes to an empty CSV field and to JSON `null`.
 */
export function csvCellValue(value: string | null): string {
  if (value === null) {
    return "";
  }
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultTableToCsv(headers: string[], rows: (string | null)[][]): string {
  const lines = [headers.map(csvCellValue).join(",")];
  rows.forEach(row => lines.push(row.map(csvCellValue).join(",")));
  return lines.join("\n");
}

export function resultTableToJson(headers: string[], rows: (string | null)[][]): string {
  return JSON.stringify(
    rows.map(row => {
      const obj: Record<string, string | null> = {};
      headers.forEach((header, index) => { obj[header] = row[index]; });
      return obj;
    }),
    null,
    2
  );
}

function cellToDisplayValue(v: any): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Buffer) {
    return v.toString();
  }
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return new Date(v).toISOString();
  }
  if (typeof v === "object") {
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * Outline entries for a `.sql` file — the pure half, so it is testable without VS Code.
 *
 * See docs/roadmap/sql-language-features.md. `splitStatementsWithOffsets()` already does the hard
 * part (string literals, comments, `SET TERM`, PSQL `BEGIN`/`END` nesting), so this is only the
 * mapping from a statement's text to a label and a symbol kind. Needs no database connection,
 * which is why it works in a file that was never connected to anything.
 */

import { splitStatementsWithOffsets } from "../shared/sql-splitter";

/** Mirrors the subset of `vscode.SymbolKind` used here, so this module imports no vscode. */
export type SqlSymbolKind = "class" | "function" | "event" | "field" | "constant" | "interface" | "method";

export interface SqlSymbol {
  /** What the Outline view shows, e.g. `CREATE TABLE CUSTOMERS`. */
  label: string;
  kind: SqlSymbolKind;
  /** `[start, end)` offsets in the original document, straight from the splitter. */
  start: number;
  end: number;
}

/**
 * Statement kinds worth naming, in match order.
 *
 * `ALTER TABLE` before `ALTER` and `CREATE OR ALTER` before `CREATE` matter: a prefix table is
 * only correct if the longer forms are tried first.
 */
const STATEMENT_PATTERNS: { re: RegExp; kind: SqlSymbolKind }[] = [
  { re: /^(CREATE\s+OR\s+ALTER|RECREATE|CREATE|ALTER|DROP)\s+(TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|SEQUENCE|GENERATOR|EXCEPTION|DOMAIN|INDEX|ROLE|SCHEMA|PACKAGE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z0-9_$."]+)/i, kind: "class" },
  { re: /^(SELECT)\b/i, kind: "field" },
  { re: /^(INSERT\s+INTO)\s+([A-Za-z0-9_$."]+)/i, kind: "method" },
  { re: /^(UPDATE)\s+([A-Za-z0-9_$."]+)/i, kind: "method" },
  { re: /^(DELETE\s+FROM)\s+([A-Za-z0-9_$."]+)/i, kind: "method" },
  { re: /^(MERGE\s+INTO)\s+([A-Za-z0-9_$."]+)/i, kind: "method" },
  { re: /^(EXECUTE\s+BLOCK|EXECUTE\s+PROCEDURE|EXECUTE\s+STATEMENT)/i, kind: "function" },
  { re: /^(GRANT|REVOKE)\b/i, kind: "constant" },
  { re: /^(SET\s+TERM|SET\s+GENERATOR|SET\s+SEARCH_PATH|SET)\b/i, kind: "constant" },
  { re: /^(COMMIT|ROLLBACK)\b/i, kind: "event" },
];

/**
 * Strips leading comments so the label reflects the statement, not its documentation.
 *
 * The splitter deliberately includes a preceding comment in a statement's range (so "run the
 * statement under the cursor" works when the cursor is on that comment), which means the raw text
 * often starts with `--` or a block comment.
 */
function statementBody(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      if (newline === -1) { return ""; }
      rest = rest.slice(newline + 1).trimStart();
      continue;
    }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      if (close === -1) { return ""; }
      rest = rest.slice(close + 2).trimStart();
      continue;
    }
    return rest;
  }
}

/** Collapses whitespace so a statement spanning many lines still yields a one-line label. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const MAX_LABEL = 60;

export function buildSqlSymbols(sql: string): SqlSymbol[] {
  const symbols: SqlSymbol[] = [];

  for (const statement of splitStatementsWithOffsets(sql)) {
    const body = statementBody(statement.text);
    if (!body) {
      continue; // comment-only chunk: nothing worth an outline entry
    }

    const flat = oneLine(body);
    let label: string | undefined;
    let kind: SqlSymbolKind = "interface";

    for (const pattern of STATEMENT_PATTERNS) {
      const match = pattern.re.exec(flat);
      if (match) {
        kind = pattern.kind;
        // Group 1 is the verb phrase (`INSERT INTO`, not just `INSERT`, so the label reads the
        // way the statement does); the remaining groups name the object, when there is one.
        label = oneLine(match.slice(1).filter(Boolean).join(" ")).toUpperCase();
        break;
      }
    }

    // Unrecognised statements still get an entry — an outline that silently omits statements is
    // worse than one with a generic row, because the gap is invisible.
    if (!label) {
      label = flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
    }

    symbols.push({
      label,
      kind,
      start: statement.start,
      end: statement.end,
    });
  }

  return symbols;
}

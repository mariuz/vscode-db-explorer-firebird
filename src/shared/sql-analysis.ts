/**
 * Pure, dependency-free SQL analysis helpers shared between src/shared/driver.ts (the extension
 * host's own NodeClient-fallback execution plan) and src/mcp-server/server.ts — a separate spawned
 * subprocess that can't import driver.ts at all, since that pulls in `vscode`, which doesn't exist
 * in a plain Node process. Kept here so both places use the exact same logic rather than two
 * copies silently drifting apart.
 */

import { splitStatements } from "./sql-splitter";

/**
 * Extracts unqualified table/view names from a SQL SELECT statement's FROM and JOIN clauses.
 * This is a best-effort heuristic for the node-firebird explain-plan fallback.
 */
export function extractTableNames(sql: string): string[] {
  const names = new Set<string>();
  // Match: FROM <name>, JOIN <name>  — stop at whitespace, comma, or paren
  const re = /\b(?:FROM|JOIN)\s+([A-Z_$][A-Z0-9_$]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    names.add(m[1].toUpperCase());
  }
  return Array.from(names);
}

/** Builds the index-metadata query used by the NodeClient (non-native-driver) execution-plan fallback. */
export function buildIndexMetadataQuery(tables: string[]): string {
  const placeholders = tables.map(() => "?").join(", ");
  return `SELECT TRIM(i.RDB$RELATION_NAME) AS TABLE_NAME,
       TRIM(i.RDB$INDEX_NAME)    AS INDEX_NAME,
       TRIM(s.RDB$FIELD_NAME)    AS FIELD_NAME,
       i.RDB$UNIQUE_FLAG         AS IS_UNIQUE
  FROM RDB$INDICES i
  JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
 WHERE TRIM(i.RDB$RELATION_NAME) IN (${placeholders})
 ORDER BY 1, 2, s.RDB$FIELD_POSITION`;
}

/** Renders the NodeClient fallback plan's human-readable text from buildIndexMetadataQuery()'s rows. */
export function renderIndexMetadataPlan(stmt: string, tables: string[], rows: any[]): string {
  if (tables.length === 0) {
    return `-- PLAN not available via node-firebird driver.\n-- Use the native driver (firebird.useNativeDriver) for execution plans.\n-- Query:\n${stmt}`;
  }
  if (!rows || rows.length === 0) {
    return `-- No index information found for table(s): ${tables.join(", ")}\n-- Query:\n${stmt}`;
  }

  let plan = `-- Firebird Index Metadata (node-firebird fallback plan)\n-- Use native driver for real PLAN output.\n--\n-- Query:\n`;
  stmt.split("\n").forEach(l => (plan += `--   ${l}\n`));
  plan += "\n";
  let lastTable = "";
  rows.forEach((r: any) => {
    const tbl = (r.TABLE_NAME ?? "").trim();
    if (tbl !== lastTable) {
      plan += `\nTABLE ${tbl}\n`;
      lastTable = tbl;
    }
    const uniq = r.IS_UNIQUE ? " (UNIQUE)" : "";
    plan += `  INDEX ${(r.INDEX_NAME ?? "").trim()}${uniq} — field: ${(r.FIELD_NAME ?? "").trim()}\n`;
  });
  return plan;
}

/** Strips a leading run of whitespace/line comments/block comments, to see what keyword a statement actually starts with. */
function stripLeadingCommentsAndWhitespace(sql: string): string {
  let text = sql;
  for (;;) {
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newlineIndex = trimmed.indexOf("\n");
      text = newlineIndex === -1 ? "" : trimmed.slice(newlineIndex + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const endIndex = trimmed.indexOf("*/");
      text = endIndex === -1 ? "" : trimmed.slice(endIndex + 2);
      continue;
    }
    return trimmed;
  }
}

const READ_ONLY_LEADING_KEYWORD = /^(SELECT|WITH)\b/i;

/**
 * Validates that `sql` is exactly one read-only statement (a SELECT, or a WITH ... AS (...) SELECT
 * common table expression — Firebird's WITH clause can only wrap a SELECT, never DML) — used by
 * the MCP server's run_query tool to reject anything else (INSERT/UPDATE/DELETE/DDL/EXECUTE BLOCK/
 * multi-statement scripts) before it ever reaches a real connection. Returns an error message
 * describing why the input was rejected, or undefined if it's acceptable to run as-is.
 */
export function validateReadOnlyStatement(sql: string): string | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return "No SQL statement found.";
  }
  if (statements.length > 1) {
    return `Only a single SELECT statement is allowed; got ${statements.length} statements.`;
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]);
  if (!READ_ONLY_LEADING_KEYWORD.test(stmt)) {
    return "Only SELECT (or WITH ... AS (...) SELECT) statements are allowed — this tool is read-only.";
  }
  return undefined;
}

const WRITE_LEADING_KEYWORD = /^(INSERT|UPDATE|DELETE)\b/i;

/**
 * Validates that `sql` is exactly one INSERT, UPDATE, or DELETE statement — used by the MCP
 * server's opt-in run_write_query tool (docs/roadmap/mcp-server.md's write-query path) to reject
 * anything else (SELECT, DDL, EXECUTE BLOCK, MERGE, multi-statement scripts) before it ever reaches
 * a real connection. MERGE is deliberately not included in this first pass — INSERT/UPDATE/DELETE
 * covers ordinary CRUD writes; MERGE's combined insert-or-update-or-delete semantics can be added
 * later if there's real demand for it, matching this feature's "start narrow" scope. Returns an
 * error message describing why the input was rejected, or undefined if it's acceptable to run.
 */
export function validateWriteStatement(sql: string): string | undefined {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    return "No SQL statement found.";
  }
  if (statements.length > 1) {
    return `Only a single INSERT, UPDATE, or DELETE statement is allowed; got ${statements.length} statements.`;
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]);
  if (!WRITE_LEADING_KEYWORD.test(stmt)) {
    return "Only INSERT, UPDATE, or DELETE statements are allowed here — DDL (CREATE/ALTER/DROP) and EXECUTE BLOCK are rejected, and SELECT belongs in run_query instead.";
  }
  return undefined;
}

// ── Server-side paging (docs/roadmap/large-result-sets.md, phase 2) ──────────
//
// Deciding whether a statement can be re-issued as a window of itself is statement classification,
// which is why it lives here beside validateReadOnlyStatement()/validateWriteStatement() rather
// than in the result view.

/** Firebird version that introduced `OFFSET … ROWS FETCH NEXT … ROWS ONLY`. */
export const PAGING_MIN_ENGINE_VERSION = 3;

export interface PagingAnalysis {
  /** Whether {@link buildPagedQuery} may be applied to this statement. */
  pageable: boolean;
  /** Why not, phrased for a user. Only set when `pageable` is false. */
  reason?: string;
  /**
   * Whether the statement has a top-level ORDER BY. A paged query without one has no defined row
   * order, so two pages may overlap or skip rows — the caller is expected to say so rather than
   * present the pages as a window onto a stable set.
   */
  ordered: boolean;
}

/**
 * Replaces every string literal, quoted identifier and comment with spaces of the same length, so
 * keyword scanning cannot be fooled by `SELECT 'ORDER BY' FROM …` or by a commented-out clause.
 * Length is preserved so offsets into the result still index the original.
 */
function maskLiteralsAndComments(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") { out[k] = " "; }
    }
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; } // doubled quote is an escape, not the end
          break;
        }
        j++;
      }
      blank(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      blank(i, end === -1 ? sql.length : end);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      blank(i, end === -1 ? sql.length : end + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Finds `pattern` outside any parentheses.
 *
 * Depth matters for every keyword this module looks for: a subquery's own ORDER BY or FIRST clause
 * is not the statement's, and `ROWS` in a window frame (`OVER (… ROWS BETWEEN …)`) is not a paging
 * clause at all. All of them are inside parens; the statement's own are not.
 */
function matchesAtTopLevel(masked: string, pattern: RegExp): boolean {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      pattern.lastIndex = i;
      const m = pattern.exec(masked);
      if (m && m.index === i) {
        return true;
      }
    }
  }
  return false;
}

/** Anchored (sticky) so matchesAtTopLevel() can test "does this start here?" at a given offset. */
const EXISTING_LIMIT_CLAUSE = /(FIRST|SKIP|ROWS|OFFSET|FETCH)\b/iy;
const TOP_LEVEL_ORDER_BY = /ORDER\s+BY\b/iy;

/**
 * Whether `sql` can be re-issued as `sql` + an OFFSET/FETCH window, and whether doing so would
 * produce a defined row order.
 *
 * Deliberately conservative — a statement that is refused here simply keeps the existing
 * fetch-everything-then-cap behaviour, whereas one that is wrapped wrongly produces a SQL error in
 * the user's face or, worse, silently wrong rows.
 */
export function analyzePaging(sql: string, engineMajorVersion: number): PagingAnalysis {
  const masked = maskLiteralsAndComments(sql);
  const ordered = matchesAtTopLevel(masked, TOP_LEVEL_ORDER_BY);
  const no = (reason: string): PagingAnalysis => ({ pageable: false, reason, ordered });

  if (!Number.isInteger(engineMajorVersion) || engineMajorVersion < PAGING_MIN_ENGINE_VERSION) {
    // 0 means the version probe failed; treating "unknown" as "no paging" keeps the old behaviour
    // rather than sending a server syntax it may not understand.
    return no(`Server-side paging needs Firebird ${PAGING_MIN_ENGINE_VERSION} or later.`);
  }

  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    return no("Only a single statement can be paged.");
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]);
  if (!READ_ONLY_LEADING_KEYWORD.test(stmt)) {
    return no("Only SELECT (or WITH … SELECT) statements can be paged.");
  }
  if (matchesAtTopLevel(masked, EXISTING_LIMIT_CLAUSE)) {
    // Firebird rejects the combination outright — "FIRST/SKIP cannot be used with OFFSET/FETCH or
    // ROWS" — and a statement that already limits itself is one the user has already bounded.
    return no("This statement already limits its own rows (FIRST/SKIP, ROWS or OFFSET/FETCH).");
  }
  return { pageable: true, ordered };
}

/**
 * Appends an OFFSET/FETCH window to a statement {@link analyzePaging} accepted.
 *
 * The newline is not cosmetic: a statement may end in a `--` line comment, and appending on the
 * same line would comment the window out and quietly return the whole result instead.
 */
export function buildPagedQuery(sql: string, offset: number, limit: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page offset: ${offset}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid page size: ${limit}`);
  }
  // Only a trailing statement separator is removed, and only outside a literal — hence the mask.
  const masked = maskLiteralsAndComments(sql);
  let end = masked.length;
  while (end > 0 && (/\s/.test(masked[end - 1]) || masked[end - 1] === ";")) {
    end--;
  }
  return `${sql.slice(0, end)}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

/**
 * The table behind a statement that selects a whole table and nothing else, or undefined.
 *
 * This is the gate for filter/sort push-down (docs/roadmap/large-result-sets.md, phase 3). Pushing
 * a filter down means *re-writing* the statement as `SELECT * FROM t WHERE …`, which is only
 * equivalent to what the user is looking at when the statement really is the whole table: doing it
 * to `SELECT ID FROM T WHERE X > 5` would silently drop their predicate and change the columns.
 *
 * An existing ORDER BY is allowed, since sorting replaces it wholesale; anything else — a WHERE, a
 * join, a GROUP BY, an explicit column list, a CTE — disqualifies the statement, which then keeps
 * plain paging.
 */
export function wholeTableSelect(sql: string): string | undefined {
  const statements = splitStatements(sql);
  if (statements.length !== 1) {
    return undefined;
  }
  const stmt = stripLeadingCommentsAndWhitespace(statements[0]).replace(/;\s*$/, "").trim();
  // Two-part names are Firebird 6 schema-qualified ones (SALES.ORDERS); the trailing ORDER BY is
  // consumed rather than rejected because push-down rewrites it.
  const match = /^SELECT\s+\*\s+FROM\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\s*(ORDER\s+BY\s+[^;]*)?$/i
    .exec(stmt);
  return match ? match[1] : undefined;
}

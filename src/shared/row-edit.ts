/**
 * Pure SQL statement builders for directly editing query results (update, insert, delete a
 * row from a result grid). Kept free of any vscode/Driver dependency so the statement-building
 * logic is exhaustively unit-testable; src/result-view/index.ts is responsible for actually
 * executing what these functions produce.
 *
 * Row values arrive as the same string[] the grid already renders (see encodeRow() in
 * src/result-view/index.ts), including its NULL_SENTINEL for NULL cells.
 */

/** How a NULL cell is rendered in the result grid (see encodeRow()). */
export const NULL_SENTINEL = "&lt;null&gt;";

/** A single pending edit made in the results grid, ready to be turned into SQL. */
export interface RowChange {
  type: "update" | "insert" | "delete";
  /** Required for "update"/"delete": the row's values as last fetched, used to target it. */
  originalRow?: string[];
  /** Required for "update"/"insert": the columns being written, sparse (only touched cells). */
  values?: { colIndex: number; value: string }[];
}

function isNullValue(value: string): boolean {
  return value === NULL_SENTINEL || value === "<null>";
}

/** Formats a grid cell's string value as a SQL literal (quoted string, bare number, or NULL). */
export function quoteSqlValue(value: string): string {
  if (isNullValue(value)) {
    return "NULL";
  }
  const n = Number(value);
  if (value.trim() !== "" && !isNaN(n)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Throws if `name` isn't a safe, unquoted Firebird identifier — the only kind these builders
 * accept. This is the injection guard for every statement they generate, so it stays deliberately
 * strict: no quotes, no whitespace, no semicolons, nothing that could close a literal.
 *
 * A **two-part** `SCHEMA.OBJECT` name is accepted on the same terms, with each half validated
 * independently against the same rule. Firebird 6 tables outside the default schema have to be
 * qualified to be addressed at all (see docs/roadmap/firebird6-schemas.md), and rejecting the dot
 * would mean row editing failing with "Invalid table name" on exactly those tables. Splitting on
 * the *first* dot and requiring both halves to match keeps the guarantee intact: a name with two
 * dots, an empty half, or anything unsafe in either half is still rejected.
 */
export function assertValidIdentifier(name: string, what: string): void {
  const parts = name.split(".");
  const valid =
    parts.length <= 2 && parts.length > 0 && parts.every(part => IDENTIFIER_RE.test(part));
  if (!valid) {
    throw new Error(`Invalid ${what}: "${name}". Only alphanumeric identifiers are allowed.`);
  }
}

/**
 * Builds a WHERE clause identifying one row. Uses the table's primary key columns when known
 * (safe even when other columns are NULL or duplicated across rows); falls back to matching
 * every column when there's no known primary key.
 */
export function buildWhereClause(columns: string[], row: string[], pkColumns: string[]): string {
  const keyColumns = pkColumns.length > 0 ? pkColumns : columns;
  if (keyColumns.length === 0) {
    throw new Error("Cannot build a WHERE clause: the result has no columns.");
  }
  const clauses = keyColumns.map(col => {
    const idx = columns.indexOf(col);
    if (idx === -1) {
      throw new Error(`Primary key column "${col}" was not found among the result columns.`);
    }
    assertValidIdentifier(col, "column name");
    const value = row[idx];
    return isNullValue(value) ? `${col} IS NULL` : `${col} = ${quoteSqlValue(value)}`;
  });
  return clauses.join(" AND ");
}

/** Builds an UPDATE statement for the changed cells in a single row. */
export function buildUpdateStatement(
  table: string,
  columns: string[],
  changedFields: { colIndex: number; newValue: string }[],
  originalRow: string[],
  pkColumns: string[]
): string {
  assertValidIdentifier(table, "table name");
  if (changedFields.length === 0) {
    throw new Error("No changed fields to update.");
  }
  const setClauses = changedFields
    .map(cf => {
      const col = columns[cf.colIndex];
      assertValidIdentifier(col, "column name");
      return `${col} = ${quoteSqlValue(cf.newValue)}`;
    })
    .join(", ");
  const where = buildWhereClause(columns, originalRow, pkColumns);
  return `UPDATE ${table} SET ${setClauses} WHERE ${where}`;
}

/** Builds an INSERT statement from the cells the user filled in for a new row. */
export function buildInsertStatement(
  table: string,
  columns: string[],
  values: { colIndex: number; value: string }[]
): string {
  assertValidIdentifier(table, "table name");
  if (values.length === 0) {
    throw new Error("No values provided for the new row.");
  }
  const colNames = values.map(v => {
    const col = columns[v.colIndex];
    assertValidIdentifier(col, "column name");
    return col;
  });
  const literals = values.map(v => quoteSqlValue(v.value));
  return `INSERT INTO ${table} (${colNames.join(", ")}) VALUES (${literals.join(", ")})`;
}

/** Builds a DELETE statement targeting a single row. */
export function buildDeleteStatement(
  table: string,
  columns: string[],
  originalRow: string[],
  pkColumns: string[]
): string {
  assertValidIdentifier(table, "table name");
  const where = buildWhereClause(columns, originalRow, pkColumns);
  return `DELETE FROM ${table} WHERE ${where}`;
}

/** Dispatches a RowChange to the matching statement builder. */
export function buildStatementForChange(
  table: string,
  columns: string[],
  pkColumns: string[],
  change: RowChange
): string {
  switch (change.type) {
    case "update":
      if (!change.originalRow || !change.values) {
        throw new Error("An update change requires both originalRow and values.");
      }
      return buildUpdateStatement(
        table,
        columns,
        change.values.map(v => ({ colIndex: v.colIndex, newValue: v.value })),
        change.originalRow,
        pkColumns
      );
    case "insert":
      if (!change.values) {
        throw new Error("An insert change requires values.");
      }
      return buildInsertStatement(table, columns, change.values);
    case "delete":
      if (!change.originalRow) {
        throw new Error("A delete change requires originalRow.");
      }
      return buildDeleteStatement(table, columns, change.originalRow, pkColumns);
  }
}

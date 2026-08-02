/**
 * Assembles the raw rows from getSchemaColumnsQuery()/getForeignKeysQuery() into a SchemaGraph
 * — the shape the Schema Designer's webview renders as an ER diagram and edits in place. Kept
 * free of any vscode/Driver dependency so it's unit-testable without a database.
 */

import { schemaDisplayName, schemaQualifiedName } from "../shared/schema-support";

export interface SchemaColumn {
  name: string;
  type: string;
  length: number;
  notNull: boolean;
  isPrimaryKey: boolean;
  /** Bare default value expression (no leading "DEFAULT" keyword), if any. */
  dflt?: string;
  /** RDB$FIELD_SUB_TYPE: 1 = NUMERIC, 2 = DECIMAL, 0/undefined = plain (not a fixed-point type). Confirmed directly against a live Firebird server, not assumed. */
  subType?: number;
  /** RDB$FIELD_PRECISION — total significant digits, only meaningful when subType is 1 or 2. */
  precision?: number;
  /** RDB$FIELD_SCALE — negative; decimal places = -scale. Only meaningful when subType is 1 or 2. */
  scale?: number;
}

export interface SchemaTable {
  /**
   * The table's identity, and the name that goes into generated DDL — schema-qualified on
   * Firebird 6 so nothing is left to the session's search path. Used as the key for positions,
   * relationship endpoints and focus matching, so it must stay stable and unambiguous.
   */
  name: string;
  /**
   * What to show on the diagram. Drops a redundant default-schema prefix, so a single-schema
   * Firebird 6 database does not read `PUBLIC.` on every box, while a table from another schema
   * stays qualified because that is the only thing telling two same-named tables apart. Absent
   * when it would equal `name`.
   */
  displayName?: string;
  /** The owning schema, when the server has them (Firebird 6+). */
  schema?: string;
  columns: SchemaColumn[];
}

export interface SchemaRelationship {
  constraintName: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface SchemaGraph {
  tables: SchemaTable[];
  relationships: SchemaRelationship[];
}

/** Row shape returned by getSchemaColumnsQuery(). */
export interface SchemaColumnRow {
  /** Firebird 6+ only, and only when the query was asked for it. */
  SCHEMA_NAME?: string | null;
  TABLE_NAME: string;
  FIELD_NAME: string;
  FIELD_TYPE: string;
  FIELD_LENGTH: number | null;
  FIELD_SUB_TYPE?: number | null;
  FIELD_PRECISION?: number | null;
  FIELD_SCALE?: number | null;
  NOT_NULL: number;
  IS_PRIMARY_KEY: number;
  /** Raw RDB$DEFAULT_SOURCE text (e.g. "DEFAULT 0"), or null/empty if there's no default. */
  DFLT_VALUE?: string | null;
}

/** Row shape returned by getForeignKeysQuery(). */
export interface ForeignKeyRow {
  /** Firebird 6+ only. Each side carries its own, since a key may cross schemas. */
  SCHEMA_NAME?: string | null;
  REF_SCHEMA_NAME?: string | null;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
  REF_TABLE_NAME: string;
  REF_COLUMN_NAME: string;
}

/** Strips a leading "DEFAULT" keyword from RDB$DEFAULT_SOURCE, leaving just the value expression. Exported for reuse by other per-object DDL builders (e.g. Script as Create) that read the same raw column shape. */
export function normalizeDefault(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^DEFAULT\s+/i, "").trim() || undefined;
}

/**
 * Groups column rows by table (in query order, so columns stay in RDB$FIELD_POSITION order) and
 * attaches the foreign key relationships, ready for the webview to lay out, draw, and edit.
 */
export function buildSchemaGraph(columnRows: SchemaColumnRow[], fkRows: ForeignKeyRow[]): SchemaGraph {
  const tablesByName = new Map<string, SchemaTable>();

  for (const row of columnRows) {
    // Keyed by the *qualified* name when the rows carry a schema (Firebird 6+). Keying by the bare
    // name merges SALES.ORDERS and PUBLIC.ORDERS into a single box holding the union of their
    // columns — a table that exists nowhere. Rows without a schema keep their bare name, so every
    // pre-6 server and every caller that has not opted in behaves exactly as before.
    const tableName = schemaQualifiedName(row.SCHEMA_NAME ?? undefined, row.TABLE_NAME);
    let table = tablesByName.get(tableName);
    if (!table) {
      const schema = row.SCHEMA_NAME?.trim() || undefined;
      const displayName = schemaDisplayName(schema, row.TABLE_NAME);
      table = {
        name: tableName,
        // Only carried when it differs, so consumers can keep using `name` unchanged.
        ...(displayName !== tableName ? { displayName } : {}),
        ...(schema ? { schema } : {}),
        columns: [],
      };
      tablesByName.set(tableName, table);
    }
    table.columns.push({
      name: row.FIELD_NAME.trim(),
      type: row.FIELD_TYPE.trim(),
      length: row.FIELD_LENGTH ?? 0,
      notNull: !!row.NOT_NULL,
      isPrimaryKey: !!row.IS_PRIMARY_KEY,
      dflt: normalizeDefault(row.DFLT_VALUE),
      subType: row.FIELD_SUB_TYPE ?? undefined,
      precision: row.FIELD_PRECISION ?? undefined,
      scale: row.FIELD_SCALE ?? undefined,
    });
  }

  const relationships: SchemaRelationship[] = fkRows.map(row => ({
    constraintName: row.CONSTRAINT_NAME.trim(),
    // Both ends qualified independently: a foreign key may reference another schema's table, so
    // the two sides can legitimately differ.
    table: schemaQualifiedName(row.SCHEMA_NAME ?? undefined, row.TABLE_NAME),
    column: row.COLUMN_NAME.trim(),
    refTable: schemaQualifiedName(row.REF_SCHEMA_NAME ?? undefined, row.REF_TABLE_NAME),
    refColumn: row.REF_COLUMN_NAME.trim(),
  }));

  return {
    tables: Array.from(tablesByName.values()),
    relationships,
  };
}

/**
 * "12 tables" / "1 table", for the Schema Designer's layout progress caption.
 *
 * Counts distinct tables straight from the column rows rather than from a built graph, because the
 * caption is shown *before* `buildSchemaGraph()` runs — deriving the number from the work being
 * announced would mean doing that work first, which defeats the point of announcing it.
 *
 * Keyed by schema *and* name for the same reason the graph is: on Firebird 6, `SALES.ORDERS` and
 * `PUBLIC.ORDERS` are two tables, and counting by bare name would under-report exactly the
 * databases where the wait is longest.
 */
export function describeTableCount(columnRows: Pick<SchemaColumnRow, "TABLE_NAME" | "SCHEMA_NAME">[]): string {
  const names = new Set(
    columnRows.map(row => `${(row.SCHEMA_NAME ?? "").trim()}.${String(row.TABLE_NAME ?? "").trim()}`)
  );
  return names.size === 1 ? "1 table" : `${names.size} tables`;
}

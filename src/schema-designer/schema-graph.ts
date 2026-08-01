/**
 * Assembles the raw rows from getSchemaColumnsQuery()/getForeignKeysQuery() into a SchemaGraph
 * — the shape the Schema Designer's webview renders as an ER diagram and edits in place. Kept
 * free of any vscode/Driver dependency so it's unit-testable without a database.
 */

import { schemaQualifiedName } from "../shared/schema-support";

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
  name: string;
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
      table = { name: tableName, columns: [] };
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

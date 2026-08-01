/**
 * Builds an OpenAPI 3.0 spec (paths + component schemas, one CRUD route set per table) from a
 * SchemaGraph — the same model the Schema Designer/schema-diff already assemble from
 * getSchemaColumnsQuery(). No vscode/Driver dependency, so it's unit-testable without a database,
 * matching schema-graph.ts's own convention.
 *
 * Per the design doc (docs/roadmap/data-api-builder.md), this is Option A: a reviewable artifact
 * generated for the user's own backend, not a bundled server the extension runs itself — the spec
 * is meant to be opened as plain text for review, the same as this extension's generated DDL.
 *
 * JSON, not YAML: OpenAPI supports both equally, and JSON needs no new serialization dependency
 * (no YAML library is vendored in this extension today).
 */

import { SchemaGraph, SchemaTable, SchemaColumn } from "../schema-designer/schema-graph";

export type TableAccessLevel = "full" | "read-only";

/**
 * Column-level scoping (docs/roadmap/data-api-builder.md, phase 5). `tableAccess` used to be a bare
 * access level per table; it now also accepts this object so a table can be exposed without every
 * one of its columns — the case the feature most obviously serves is a table that has a
 * `PASSWORD_HASH`, `SALARY`, or internal audit column you don't want in a public REST surface.
 *
 * `includeColumns` wins over `excludeColumns` when both are given (an allow-list is the more
 * explicit statement of intent). Names are matched case-insensitively, and a name that matches no
 * real column is ignored — the same "validate against ground truth, don't trust the input" rule
 * `parseTableAccessResponse()` already applies to table names.
 */
export interface TableAccessSpec {
  access: TableAccessLevel;
  includeColumns?: string[];
  excludeColumns?: string[];
}

/** The bare level is still accepted everywhere, so phase 3's callers are unchanged. */
export type TableAccess = TableAccessLevel | TableAccessSpec;

/** Widens the bare-level form to the object form, so the rest of this module handles one shape. */
export function normalizeTableAccess(access: TableAccess | undefined): TableAccessSpec {
  if (access === undefined) { return { access: "full" }; }
  return typeof access === "string" ? { access } : access;
}

/**
 * The columns of `table` this spec exposes. An empty result means the table shouldn't appear in the
 * spec at all — an entity with no columns is not a useful thing to generate routes for.
 */
export function visibleColumns(table: SchemaTable, spec: TableAccessSpec): SchemaColumn[] {
  const include = spec.includeColumns?.map(name => name.toUpperCase());
  const exclude = spec.excludeColumns?.map(name => name.toUpperCase());
  if (include && include.length > 0) {
    return table.columns.filter(col => include.includes(col.name.toUpperCase()));
  }
  if (exclude && exclude.length > 0) {
    return table.columns.filter(col => !exclude.includes(col.name.toUpperCase()));
  }
  return table.columns;
}

/**
 * The access level actually generated, which can be narrower than the one asked for.
 *
 * **A write needs every mandatory column to be writable.** If a hidden column is `NOT NULL` and has
 * no default, a generated `POST` body could never satisfy it and every create would fail at the
 * server — so the table is downgraded to read-only rather than emitting routes that cannot work.
 * A hidden `NOT NULL` column *with* a default is fine: the database fills it in.
 */
export function effectiveAccess(table: SchemaTable, spec: TableAccessSpec): TableAccessLevel {
  if (spec.access === "read-only") { return "read-only"; }
  const visible = new Set(visibleColumns(table, spec).map(col => col.name));
  const unsatisfiable = table.columns.some(col => !visible.has(col.name) && col.notNull && !col.dflt);
  return unsatisfiable ? "read-only" : "full";
}

export interface OpenApiSpecOptions {
  title?: string;
  version?: string;
  /**
   * Per-table access override, keyed by table name (docs/roadmap/data-api-builder.md phase 3 —
   * Copilot-assisted scoping, e.g. "expose customers and orders as read-only"). When set, a table
   * *not* present here is excluded from the generated spec entirely — this is both the inclusion
   * list and the access level in one map, so there's no separate "which tables" option to keep in
   * sync with it. Leaving this option unset (the default, used by the plain "generate for the
   * whole schema" command) includes every table with full CRUD access, exactly as before this
   * option existed.
   */
  tableAccess?: Record<string, TableAccess>;
}

interface JsonSchemaType {
  type: string;
  format?: string;
}

/** Firebird's own RDB$FIELD_TYPE names (see getSchemaColumnsQuery()'s CASE) -> JSON Schema type/format. */
const FIREBIRD_TYPE_TO_JSON_SCHEMA: Record<string, JsonSchemaType> = {
  SMALLINT: { type: "integer" },
  INTEGER: { type: "integer" },
  INT64: { type: "integer", format: "int64" },
  FLOAT: { type: "number", format: "float" },
  DOUBLE: { type: "number", format: "double" },
  D_FLOAT: { type: "number" },
  DATE: { type: "string", format: "date" },
  TIME: { type: "string" },
  TIMESTAMP: { type: "string", format: "date-time" },
  CHAR: { type: "string" },
  VARCHAR: { type: "string" },
  CSTRING: { type: "string" },
  BLOB: { type: "string" },
  QUAD: { type: "string" },
};

/** Exported for unit testing. Unknown/UNKNOWN Firebird types fall back to a bare string schema. */
export function jsonSchemaForColumn(column: SchemaColumn): Record<string, any> {
  const mapped = FIREBIRD_TYPE_TO_JSON_SCHEMA[column.type] ?? { type: "string" };
  const schema: Record<string, any> = { ...mapped };
  if ((column.type === "VARCHAR" || column.type === "CHAR") && column.length) {
    schema.maxLength = column.length;
  }
  if (!column.notNull) {
    schema.nullable = true;
  }
  return schema;
}

function buildTableSchema(columns: SchemaColumn[]): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  columns.forEach(col => {
    properties[col.name] = jsonSchemaForColumn(col);
    if (col.notNull) {
      required.push(col.name);
    }
  });
  const schema: Record<string, any> = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function primaryKeyColumns(columns: SchemaColumn[]): SchemaColumn[] {
  return columns.filter(c => c.isPrimaryKey);
}

/**
 * The name a table is published under.
 *
 * The graph's `name` is schema-qualified on Firebird 6 (`PUBLIC.ORDERS`) because it doubles as the
 * table's identity for DDL, where relying on the search path is a bug. That is the wrong thing to
 * put in a route or a schema component: on a single-schema database every path would gain a
 * redundant `public.` segment. `displayName` drops exactly that prefix and keeps a qualification
 * that actually disambiguates, so `SALES.ORDERS` stays distinct from `ORDERS`.
 */
function publishedName(table: SchemaTable): string {
  return table.displayName ?? table.name;
}

/** e.g. "orders/{id}" or "order_items/{order_id}/{line_no}" for a composite key. */
function itemPathSuffix(columns: SchemaColumn[]): string {
  return primaryKeyColumns(columns).map(c => `{${c.name}}`).join("/");
}

/** access "read-only" omits POST/PUT/DELETE — only the GET (list, and get-by-PK if there is one) operations are generated. */
function buildTablePaths(table: SchemaTable, columns: SchemaColumn[], access: TableAccessLevel = "full"): Record<string, any> {
  const name = publishedName(table);
  const schemaRef = { $ref: `#/components/schemas/${name}` };
  const listPath = `/${name.toLowerCase()}`;
  const listOperations: Record<string, any> = {
    get: {
      summary: `List ${name}`,
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: schemaRef } } } },
      },
    },
  };
  if (access === "full") {
    listOperations.post = {
      summary: `Create a ${name} row`,
      requestBody: { required: true, content: { "application/json": { schema: schemaRef } } },
      responses: {
        "201": { description: "Created", content: { "application/json": { schema: schemaRef } } },
      },
    };
  }
  const paths: Record<string, any> = { [listPath]: listOperations };

  // By-primary-key routes need every PK column exposed: the path template is built from them, so a
  // hidden PK column would produce a route nobody could address. The list/create routes stay.
  const pkColumns = primaryKeyColumns(columns);
  const allPkVisible = pkColumns.length === primaryKeyColumns(table.columns).length;
  if (pkColumns.length > 0 && allPkVisible) {
    const itemPath = `${listPath}/${itemPathSuffix(columns)}`;
    const itemOperations: Record<string, any> = {
      parameters: pkColumns.map(col => ({ name: col.name, in: "path", required: true, schema: jsonSchemaForColumn(col) })),
      get: {
        summary: `Get one ${name} row by primary key`,
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaRef } } },
          "404": { description: "Not found" },
        },
      },
    };
    if (access === "full") {
      itemOperations.put = {
        summary: `Update a ${name} row`,
        requestBody: { required: true, content: { "application/json": { schema: schemaRef } } },
        responses: { "200": { description: "OK", content: { "application/json": { schema: schemaRef } } }, "404": { description: "Not found" } },
      };
      itemOperations.delete = {
        summary: `Delete a ${name} row`,
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" } },
      };
    }
    paths[itemPath] = itemOperations;
  }

  return paths;
}

/**
 * Builds a full OpenAPI 3.0 document — a CRUD route set per table, or a scoped-down subset per
 * options.tableAccess (which tables to include, and whether each gets full CRUD or GET-only).
 */
export function buildOpenApiSpec(graph: SchemaGraph, options: OpenApiSpecOptions = {}): Record<string, any> {
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

  const tables = options.tableAccess
    ? graph.tables.filter(t => options.tableAccess![t.name] !== undefined)
    : graph.tables;

  tables.forEach(table => {
    const spec = normalizeTableAccess(options.tableAccess?.[table.name]);
    const columns = visibleColumns(table, spec);
    if (columns.length === 0) {
      return; // every column filtered out — nothing meaningful to generate for this table
    }
    schemas[publishedName(table)] = buildTableSchema(columns);
    Object.assign(paths, buildTablePaths(table, columns, effectiveAccess(table, spec)));
  });

  return {
    openapi: "3.0.3",
    info: { title: options.title ?? "Firebird Data API", version: options.version ?? "1.0.0" },
    paths,
    components: { schemas },
  };
}

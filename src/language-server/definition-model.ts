/**
 * "Go to Definition" for SQL identifiers — the pure half.
 *
 * Firebird has no source file to jump to, so the definition of a table is a *generated* document:
 * its `CREATE TABLE` DDL, scripted from the catalogue. See docs/roadmap/sql-language-features.md.
 *
 * The identity problem that shapes this: pressing F12 twice on the same table must not open two
 * documents. Rather than tracking opened editors, each object gets a stable URI under a custom
 * scheme (`firebird-ddl:CUSTOMERS.sql`), and a `TextDocumentContentProvider` generates the content
 * on demand — VS Code then reuses the existing editor for a URI it has already opened, for free.
 */

import { Schema } from "../interfaces";

/** Scheme for generated DDL documents. Registered by the language server, read-only by nature. */
export const DDL_SCHEME = "firebird-ddl";

/**
 * The path portion of a generated DDL document's URI.
 *
 * `.sql` so the document opens with SQL syntax highlighting without anyone setting a language mode.
 */
export function ddlDocumentPath(objectName: string): string {
  return `${objectName.trim()}.sql`;
}

/** Inverse of {@link ddlDocumentPath}; tolerates the leading slash VS Code puts on URI paths. */
export function objectNameFromDdlPath(path: string): string {
  return path.replace(/^\//, "").replace(/\.sql$/i, "").trim();
}

/**
 * The canonically-cased table name for `identifier`, or undefined if the connected database has no
 * such table.
 *
 * Case-insensitive because unquoted Firebird identifiers fold to upper case, and returning the
 * *cached* spelling rather than what the user typed keeps the generated document's URI stable —
 * `customers` and `CUSTOMERS` must resolve to one document, not two.
 *
 * Scope: the completion cache holds tables only (`db-words.provider.ts` builds it from
 * `getTablesQuery()`), so views, procedures and the rest do not resolve yet.
 */
export function findTableName(identifier: string, schema: Schema.Database): string | undefined {
  const needle = identifier.trim().toUpperCase();
  if (!needle) {
    return undefined;
  }
  return schema.tables?.find(t => t.name.trim().toUpperCase() === needle)?.name.trim();
}

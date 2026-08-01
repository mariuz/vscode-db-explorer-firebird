/**
 * Hover content for SQL identifiers — the pure half, so it is testable without VS Code.
 *
 * Why hover at all: `registerCompletionItemProvider` was until now the *only* language provider in
 * this extension (see docs/roadmap/sql-language-features.md). The schema metadata that powers
 * completion is already cached; surfacing it where you are *reading* SQL rather than only where
 * you are typing it costs one more provider and no new queries.
 */

import { Schema } from "../interfaces";

/** Firebird identifier characters. `$` matters: every system object is `RDB$…`/`MON$…`. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * The identifier under `character` in `lineText`, or undefined if the cursor is not on one.
 *
 * Deliberately expands in both directions from the cursor rather than tokenising the line: hover
 * fires on every mouse move, the answer only depends on the immediate neighbourhood, and a SQL
 * parser here would be both slower and wrong more often (this has to cope with half-written
 * statements).
 *
 * A qualified `TABLE.COLUMN` reference yields whichever half the cursor is on, since the dot is
 * not an identifier character — which is the useful behaviour: hovering the table half should
 * describe the table.
 */
export function identifierAt(lineText: string, character: number): string | undefined {
  if (character < 0 || character > lineText.length) {
    return undefined;
  }
  // A cursor sitting just past the end of a word still belongs to that word.
  let start = character;
  while (start > 0 && IDENTIFIER_CHAR.test(lineText[start - 1])) {
    start--;
  }
  let end = character;
  while (end < lineText.length && IDENTIFIER_CHAR.test(lineText[end])) {
    end++;
  }
  const word = lineText.slice(start, end);
  return word.length > 0 ? word : undefined;
}

/** Markdown table of a table's columns, or a note when the schema cache has none. */
function columnsTable(table: Schema.Table): string {
  if (table.fields.length === 0) {
    return "_No columns known — expand the table in the Object Explorer to load its metadata._";
  }
  const rows = table.fields.map(f => `| ${f.name} | ${f.type ?? ""} |`).join("\n");
  return `| Column | Type |\n| --- | --- |\n${rows}`;
}

/**
 * Hover markdown for `identifier`, or undefined when it names nothing in the connected database —
 * in which case VS Code shows no hover at all, which is the right outcome for a keyword or an
 * alias rather than an invented "unknown object" popup.
 *
 * Matching is case-insensitive because unquoted Firebird identifiers fold to upper case, so a
 * query written as `select * from customers` still describes `CUSTOMERS`.
 */
export function buildHoverMarkdown(identifier: string, schema: Schema.Database): string | undefined {
  const needle = identifier.trim().toUpperCase();
  if (!needle) {
    return undefined;
  }

  const table = schema.tables?.find(t => t.name.trim().toUpperCase() === needle);
  if (table) {
    return `**${table.name.trim()}** — table\n\n${columnsTable(table)}`;
  }

  // Not a table: it may be a column. Several tables can share a column name, and saying which
  // ones is more useful than picking one arbitrarily.
  const owners = (schema.tables ?? []).filter(t =>
    t.fields.some(f => f.name.trim().toUpperCase() === needle)
  );
  if (owners.length === 0) {
    return undefined;
  }

  const field = owners[0].fields.find(f => f.name.trim().toUpperCase() === needle);
  const type = field?.type ? ` \`${field.type.trim()}\`` : "";
  const tableList = owners.map(t => t.name.trim()).join(", ");
  const label = owners.length === 1 ? "column of" : "column of tables";
  return `**${field?.name.trim() ?? identifier}**${type} — ${label} ${tableList}`;
}

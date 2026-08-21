import {CompletionItemProvider, TextDocument, CompletionItem, CompletionItemKind, MarkdownString, Position, CompletionContext, Range, CancellationToken} from "vscode";
import {Schema, FirebirdSchema, FirebirdReserved} from "../interfaces";
import { schemaDisplayName, schemaQualifiedName, effectiveSearchPath, searchPathRank } from "../shared/schema-support";
import {firebirdReserved, firebirdPsqlKeywords, firebirdBuiltinFunctions} from "./firebird-reserved";
import { withTimeout, resolveCompletionTimeoutMs } from "./completion-budget";

interface SchemaProvider {
  provideSchema: (doc: TextDocument) => Thenable<FirebirdSchema>;
}

/**
 * Determines the SQL context at the cursor position.
 * Exported for unit testing.
 */
export enum SqlContext {
  /** Inside a FROM or JOIN clause — suggest table names */
  FromClause,
  /** After CREATE/ALTER/DROP — suggest object types */
  DdlObject,
  /** Inside a PSQL BEGIN...END block */
  PsqlBlock,
  /** General context — suggest everything */
  General,
}

/**
 * Analyzes the document text up to the cursor to determine the current SQL context.
 * Exported for unit testing.
 */
export function getSqlContext(textBeforeCursor: string): SqlContext {
  const normalized = textBeforeCursor.replace(/\s+/g, ' ').trimEnd().toUpperCase();

  // Check if inside a PSQL block (BEGIN...END, EXECUTE BLOCK, procedure/trigger body)
  const beginCount = (normalized.match(/\bBEGIN\b/g) || []).length;
  const endCount = (normalized.match(/\bEND\b/g) || []).length;
  if (beginCount > endCount) {
    return SqlContext.PsqlBlock;
  }

  // Check if right after CREATE/ALTER/DROP (expecting object type)
  if (/\b(CREATE|ALTER|DROP|RECREATE|CREATE\s+OR\s+ALTER)\s*$/i.test(normalized)) {
    return SqlContext.DdlObject;
  }

  // Check if in FROM or JOIN clause — suggest tables
  if (/\b(FROM|JOIN|INTO|UPDATE)\s+(\w+\s*,\s*)*$/i.test(normalized)) {
    return SqlContext.FromClause;
  }

  return SqlContext.General;
}

/** DDL object types suggested after CREATE/ALTER/DROP */
const ddlObjectTypes: FirebirdReserved[] = [
  { label: "TABLE", detail: "DDL object type", documentation: "Create or modify a database table." },
  { label: "VIEW", detail: "DDL object type", documentation: "Create or modify a database view." },
  { label: "PROCEDURE", detail: "DDL object type", documentation: "Create or modify a stored procedure." },
  { label: "TRIGGER", detail: "DDL object type", documentation: "Create or modify a database trigger." },
  { label: "GENERATOR", detail: "DDL object type", documentation: "Create or modify a sequence generator." },
  { label: "SEQUENCE", detail: "DDL object type", documentation: "Create or modify a sequence (synonym for GENERATOR)." },
  { label: "DOMAIN", detail: "DDL object type", documentation: "Create or modify a domain (custom data type)." },
  { label: "INDEX", detail: "DDL object type", documentation: "Create or modify a database index." },
  { label: "EXCEPTION", detail: "DDL object type", documentation: "Create or modify a user-defined exception." },
  { label: "ROLE", detail: "DDL object type", documentation: "Create or modify a database role." },
  { label: "FUNCTION", detail: "DDL object type", documentation: "Create or modify a stored function (Firebird 3.0+)." },
  { label: "DATABASE", detail: "DDL object type", documentation: "Alter or drop a database." },
  { label: "OR ALTER", detail: "DDL modifier", documentation: "Modifies the object if it exists, creates if not.\n\nSyntax: `CREATE OR ALTER PROCEDURE ...`" },
];

export class CompletionProvider implements CompletionItemProvider {
  /**
   * @param getTimeoutMs Reads `firebird.intelliSense.completionTimeoutMs` at call time, so a
   *   change to the setting applies to the next keystroke rather than the next window.
   */
  constructor(
    private schemaProvider: SchemaProvider,
    private getTimeoutMs: () => unknown = () => undefined
  ) {}

  provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext) {
    // Keywords alone, which is what a completion falls back to when the schema is slow, is
    // cancelled, or fails. Returning something beats returning nothing: the reserved-word list is
    // useful on its own, and the schema build keeps running and populates the cache, so the very
    // next keystroke has table names.
    const withoutSchema = () => this.getCompletionItems(document, position, context, firebirdReserved, undefined, undefined);

    const work = this.schemaProvider.provideSchema(document).then(schema =>
      this.getCompletionItems(
        document,
        position,
        context,
        schema?.reservedKeywords ? firebirdReserved : undefined,
        schema?.tables?.length > 0 ? schema.tables : undefined,
        schema?.searchPath,
      )
    );

    // The token was previously ignored outright (the parameter was named `_token`), so typing
    // another character left the abandoned request still running to completion.
    if (token?.isCancellationRequested) {
      return withoutSchema();
    }
    return withTimeout(work, resolveCompletionTimeoutMs(this.getTimeoutMs()), withoutSchema);
  }

  private getCompletionItems(document: TextDocument, position: Position, context: CompletionContext, reservedWords?: FirebirdReserved[], tables?: Schema.Table[], connectionSearchPath?: string[]) {
    const items: CompletionItem[] = [];

    let triggeredByDot = context.triggerCharacter === '.' || (context.triggerKind === 0 && document.lineAt(position).text[position.character - 1] === '.');

    // Get text before cursor for context analysis
    const textBeforeCursor = document.getText(new Range(new Position(0, 0), position));
    const sqlContext = getSqlContext(textBeforeCursor);

    if (tables) {
      const tableItems: TableCompletionItem[] = [];
      const columnItems: ColumnCompletionItem[] = [];
      const text = document.getText();

      if (triggeredByDot) {
        const tableName: string = document.getText(document.getWordRangeAtPosition(position.translate(0, -1), /\w+(?=\.)/));
        const alias = text.match(RegExp(`((from)|(join)) (?<alias>\\w+) (as )?(?!(on)|=|(with)|(using)|(as))(${tableName})`, 'i'))?.groups?.alias;
        const tbl = tables.find(currTable => currTable.name.toLowerCase() === (alias ?? tableName).toLowerCase());
        if (tbl) {
          columnItems.push(...tbl.fields.map(col => new ColumnCompletionItem(col.name, `${tbl.name}.${col.name}: ${col.type}`)));
        } else {
          triggeredByDot = false;
        }
      }
      if (!triggeredByDot) {
        // In FROM/JOIN context, prioritize table names
        if (sqlContext === SqlContext.FromClause || sqlContext === SqlContext.General) {
          const searchPath = rankingSearchPath(tables, text, connectionSearchPath);
          tables.forEach(tbl => {
            const alias = text.match(RegExp(`((from)|(join)) ${tbl.name} (as )?(?!(on)|=|(with)|(using)|(as))(?<alias>\\w+)`, 'i'))?.groups?.alias;
            const parts = tableCompletionParts(tbl, searchPath);
            tableItems.push(new TableCompletionItem(parts.label, parts.detail, tbl.fields, parts.insertText, parts.sortText));
            if (alias) {
              // The alias stands for the same table, so it earns the same rank.
              tableItems.push(new TableCompletionItem(alias, tbl.name, tbl.fields, undefined, rankedSortText(alias, tbl, searchPath)));
            }
          });
        }
      }
      items.push(...tableItems, ...columnItems);
    }

    if (reservedWords && !triggeredByDot) {
      if (sqlContext === SqlContext.DdlObject) {
        // After CREATE/ALTER/DROP, suggest object types
        items.push(...ddlObjectTypes.map(word => new KeywordCompletionItem(word)));
      } else if (sqlContext === SqlContext.PsqlBlock) {
        // Inside PSQL blocks, include PSQL keywords and built-in functions first
        items.push(...firebirdPsqlKeywords.map(word => new PsqlCompletionItem(word)));
        items.push(...firebirdBuiltinFunctions.map(word => new FunctionCompletionItem(word)));
        items.push(...reservedWords.map(word => new KeywordCompletionItem(word)));
      } else if (sqlContext === SqlContext.FromClause) {
        // In FROM clause, only provide table-related keywords
        const fromKeywords = reservedWords.filter(w =>
          ['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL', 'ON', 'AS'].includes(w.label)
        );
        items.push(...fromKeywords.map(word => new KeywordCompletionItem(word)));
      } else {
        // General context: all keywords, functions, and PSQL keywords
        items.push(...reservedWords.map(word => new KeywordCompletionItem(word)));
        items.push(...firebirdBuiltinFunctions.map(word => new FunctionCompletionItem(word)));
        items.push(...firebirdPsqlKeywords.map(word => new PsqlCompletionItem(word)));
      }
    }
    return items;
  }

}

class KeywordCompletionItem extends CompletionItem {
  constructor(word: FirebirdReserved) {
    super(word.label, CompletionItemKind.Keyword);
    this.detail = word.detail;
    if (word.documentation) {
      this.documentation = new MarkdownString(word.documentation);
    }
  }
}

class FunctionCompletionItem extends CompletionItem {
  constructor(word: FirebirdReserved) {
    super(word.label, CompletionItemKind.Function);
    this.detail = word.detail;
    if (word.documentation) {
      this.documentation = new MarkdownString(word.documentation);
    }
  }
}

class PsqlCompletionItem extends CompletionItem {
  constructor(word: FirebirdReserved) {
    super(word.label, CompletionItemKind.Snippet);
    this.detail = word.detail;
    if (word.documentation) {
      this.documentation = new MarkdownString(word.documentation);
    }
  }
}

/**
 * The search path table completions should be ranked by, or `undefined` for no ranking at all.
 *
 * Ranking is withheld unless the tables actually span more than one schema, and that restraint is
 * the point rather than an optimisation. A `sortText` is absolute: it orders a table against the
 * ~1 400 keywords and functions in the same list, not only against other tables. On a pre-Firebird-6
 * database, or a Firebird 6 one where nobody has run `CREATE SCHEMA`, there is nothing to rank and
 * no reason to disturb an ordering that has been stable for the extension's whole life — so those
 * databases get byte-identical output to before.
 *
 * Where there *are* two schemas, tables do sort above keywords. That is a real change, and the
 * trade is deliberate: the case this exists for is two identically-named tables where only one is
 * reachable unqualified, and burying the reachable one alphabetically among keywords is the
 * failure being fixed. Typing narrows by fuzzy score first in any case, so the effect is confined
 * to an unfiltered list.
 */
export function rankingSearchPath(tables: Schema.Table[], documentText: string, connectionSearchPath?: string[]): string[] | undefined {
  const schemas = new Set(tables.map(tbl => tbl.schema?.trim().toUpperCase()).filter(Boolean));
  if (schemas.size < 2) {
    return undefined;
  }
  return effectiveSearchPath(documentText, connectionSearchPath);
}

/**
 * `sortText` placing `label` in its schema's search-path tier: on-path schemas in path order first,
 * everything else after, alphabetical within each tier.
 *
 * The rank is zero-padded so tier 10 sorts after tier 9 rather than between 1 and 2 — `sortText` is
 * compared as a string, not a number — and clamped at 99 because a search path that long is a
 * pathology, not a case worth widening the format for.
 */
export function rankedSortText(label: string, table: Schema.Table, searchPath?: string[]): string | undefined {
  if (!searchPath) {
    return undefined;
  }
  const rank = Math.min(searchPathRank(table.schema, searchPath), 99);
  return `${String(rank).padStart(2, "0")}${label}`;
}

/**
 * How a table is presented in the completion list.
 *
 * The label is what a human reads — bare in the default schema, qualified elsewhere, so two
 * same-named tables are distinguishable instead of appearing as two identical entries. The
 * *inserted* text is qualified whenever a schema is known, so accepting a completion never leaves
 * the resulting SQL depending on the session's search path.
 *
 * The label stays independent of the search path on purpose. Ranking answers "which of these did
 * you most likely mean"; renaming the entries to match the path would answer "which one is this",
 * and answering that from a heuristic parse of the document text is exactly the kind of confident
 * wrongness the qualified `insertText` exists to avoid.
 *
 * Pure, and exported for that reason: driving the whole provider needs a faithful TextDocument,
 * while this is the part with a decision in it.
 */
export function tableCompletionParts(table: Schema.Table, searchPath?: string[]): { label: string; detail?: string; insertText?: string; sortText?: string } {
  const label = schemaDisplayName(table.schema, table.name);
  const sortText = rankedSortText(label, table, searchPath);
  if (!table.schema) {
    return { label, sortText };
  }
  const qualified = schemaQualifiedName(table.schema, table.name);
  return { label, detail: qualified, insertText: qualified, sortText };
}

class TableCompletionItem extends CompletionItem {
  /**
   * Creates an instance of TableCompletionItem.
   * @param {string} label
   * @param {string} [detail]
   * @param {Schema.Field[]} [fields]
   * @param {string} [insertText]
   * @param {string} [sortText] search-path tier — see {@link rankedSortText}
   * @memberof TableCompletionItem
   */
  constructor(label: string, detail?: string, fields?: Schema.Field[], insertText?: string, sortText?: string) {
    super(label, CompletionItemKind.File);
    this.detail = detail;
    if (sortText) {
      this.sortText = sortText;
    }
    if (insertText && insertText !== label) {
      this.insertText = insertText;
      // Without this VS Code filters on the inserted text, so typing `ord` would not match a
      // completion labelled ORDERS whose insert text is PUBLIC.ORDERS.
      this.filterText = label;
    }
    if (fields) {
      const mkTable = new MarkdownString(`| Field | Type | \n |---|---| `);
      fields.forEach(field => mkTable.appendMarkdown(`\n | ${field.name} | ${field.type} |`));
      this.documentation = mkTable;
    }
  }
}

class ColumnCompletionItem extends CompletionItem {
  constructor(label: string, detail?: string) {
    super(label, CompletionItemKind.Field);
    this.detail = detail;
  }
}

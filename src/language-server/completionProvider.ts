import {CompletionItemProvider, TextDocument, CompletionItem, CompletionItemKind, MarkdownString, Position, CompletionContext, Range} from "vscode";
import {Schema, FirebirdSchema, FirebirdReserved} from "../interfaces";
import {firebirdReserved, firebirdPsqlKeywords, firebirdBuiltinFunctions} from "./firebird-reserved";

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
  constructor(private schemaProvider: SchemaProvider) {}

  provideCompletionItems(document: TextDocument, position: Position, _token: unknown, context: CompletionContext) {
    return this.schemaProvider.provideSchema(document).then(schema => {
      return this.getCompletionItems(
        document,
        position,
        context,
        schema?.reservedKeywords ? firebirdReserved : undefined,
        schema?.tables?.length > 0 ? schema.tables : undefined,
      );
    });
  }

  private getCompletionItems(document: TextDocument, position: Position, context: CompletionContext, reservedWords?: FirebirdReserved[], tables?: Schema.Table[]) {
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
          tables.forEach(tbl => {
            const alias = text.match(RegExp(`((from)|(join)) ${tbl.name} (as )?(?!(on)|=|(with)|(using)|(as))(?<alias>\\w+)`, 'i'))?.groups?.alias;
            tableItems.push(new TableCompletionItem(tbl.name, undefined, tbl.fields));
            if (alias) {
              tableItems.push(new TableCompletionItem(alias, tbl.name, tbl.fields));
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

class TableCompletionItem extends CompletionItem {
  /**
   * Creates an instance of TableCompletionItem.
   * @param {string} label
   * @param {string} [detail]
   * @param {Schema.Field[]} [fields]
   * @memberof TableCompletionItem
   */
  constructor(label: string, detail?: string, fields?: Schema.Field[]) {
    super(label, CompletionItemKind.File);
    this.detail = detail;
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

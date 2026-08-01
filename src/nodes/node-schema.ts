import {ExtensionContext, ThemeIcon, TreeItem, TreeItemCollapsibleState} from "vscode";
import {FirebirdTree} from "../interfaces";

/**
 * A Firebird 6 SQL schema, sitting between a database and its object categories.
 *
 * Shown **only** when a database has more than one user schema (see `NodeDatabase.getChildren()`).
 * Every Firebird 6 database has `PUBLIC`, so showing this level unconditionally would add a
 * pointless click to the overwhelming majority of databases, which have exactly one schema and
 * always will.
 *
 * It owns no fetching of its own: it hands each category the same child factory `NodeDatabase`
 * would have used, pre-bound to this schema, so there is one implementation of "list the tables"
 * rather than a schema-scoped copy of each.
 */
export class NodeSchema implements FirebirdTree {
  constructor(
    private readonly schemaName: string,
    private readonly categoryFactory: (schema: string) => FirebirdTree[]
  ) {}

  public getSchemaName(): string {
    return this.schemaName;
  }

  public getTreeItem(_context: ExtensionContext): TreeItem {
    return {
      label: this.schemaName,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "schema",
      tooltip: `[SCHEMA] ${this.schemaName}`,
      // A themed codicon rather than an SVG pair: schemas are new in Firebird 6 and there is no
      // existing icon asset for them, and this follows the editor theme for free.
      iconPath: new ThemeIcon("symbol-namespace"),
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    return this.categoryFactory(this.schemaName);
  }
}

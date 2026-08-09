import {ExtensionContext, ThemeIcon, TreeItem, TreeItemCollapsibleState} from "vscode";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getObjectPrivilegesQuery, SCHEMA_OBJECT_TYPE} from "../shared/queries";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {logger} from "../logger/logger";

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
    private readonly categoryFactory: (schema: string) => FirebirdTree[],
    private readonly dbDetails?: ConnectionOptions
  ) {}

  public getSchemaName(): string {
    return this.schemaName;
  }

  public getDbDetails(): ConnectionOptions | undefined {
    return this.dbDetails;
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

  /**
   * Shows who may use this schema — `GRANT USAGE ON SCHEMA`, recorded in RDB$USER_PRIVILEGES like
   * any other grant.
   *
   * Restricted by object type rather than by schema: a schema's own grant rows leave
   * RDB$RELATION_SCHEMA_NAME null (the schema *is* the object, it is not in one), and without the
   * type filter a table sharing the schema's name would answer instead.
   */
  public async showPrivileges() {
    if (!this.dbDetails) {
      return;
    }
    logger.info("Custom Query: Show Object Privileges");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(
      getObjectPrivilegesQuery(this.schemaName.trim(), {objectType: SCHEMA_OBJECT_TYPE}),
      this.dbDetails
    ).catch(err => {
      logger.error(err);
      logger.showError(`Failed to fetch privileges: ${err}`);
    });
  }
}

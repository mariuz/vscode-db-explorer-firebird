import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {viewColumnsQuery, selectAllRecordsQuery, getViewDefinitionQuery, dropViewQuery, createViewScaffold, getObjectPrivilegesQuery} from "../shared/queries";
import {getOptions} from "../config";
import {schemaDisplayName, schemaQualifiedName} from "../shared/schema-support";
import {Global} from "../shared/global";
import {Driver} from "../shared/driver";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";
import {withTruncationWarning} from "../shared/utils";
import {buildViewCreateDDL} from "../database-projects/project-model";

export class NodeView implements FirebirdTree {
  /** @param schema Firebird 6+ only — see NodeTable for why it is left undefined on older servers. */
  constructor(
    private readonly dbDetails: ConnectionOptions,
    private readonly viewName: string,
    private readonly schema?: string,
    private readonly labelSchema?: string
  ) {}

  /** The name to put in SQL: qualified whenever a schema is known, never left to the search path. */
  public getViewName(): string {
    return schemaQualifiedName(this.schema, this.viewName);
  }

  /** Bare relation name, for metadata lookups that match on `RDB$RELATION_NAME`. */
  public getRelationName(): string {
    return this.viewName.trim();
  }

  public getDbDetails(): ConnectionOptions {
    return this.dbDetails;
  }

  public getDragIdentifier(): string {
    return this.getViewName();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      // Bare name in the default schema, qualified elsewhere — see schemaDisplayName().
      label: schemaDisplayName(this.schema, this.viewName, this.labelSchema),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "view",
      tooltip: `[VIEW] ${this.viewName.trim()}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "view-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "view-light.svg"))
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    const qry = viewColumnsQuery(this.viewName.trim(), this.schema);
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const columns = await Driver.client.queryPromise<any[]>(connection, qry);
      return columns.map(col => new NodeViewColumn(col));
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }

  /** Unlimited form of this view's SELECT, for the grid's pager — see NodeTable.getSelectAllSql(). */
  public getSelectAllSql(): string {
    return selectAllRecordsQuery(this.getViewName());
  }

  public async selectAllRecords() {
    logger.info("Custom Query: Select All View Records");
    // One row more than is displayed, so a full page can be told from a full table -- see
    // NodeTable.selectAllRecords().
    const maxRows = getOptions().maxResultRows;
    const qry = selectAllRecordsQuery(this.getViewName(), maxRows > 0 ? maxRows + 1 : 0);
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(qry, this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
      });
  }

  public static createView(viewName: string): void {
    logger.info("Create View: open scaffold for editing");
    Driver.createSQLTextDocument(createViewScaffold(viewName.trim()));
  }

  public async editView() {
    logger.info("Edit View: open definition for editing");
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getViewDefinitionQuery(this.viewName.trim(), this.schema));
      const source = rows[0]?.VIEW_SOURCE ?? "";
      const scaffold = source
        ? withTruncationWarning(source, `ALTER VIEW ${this.viewName.trim()} AS\n${source.trim()}`)
        : `ALTER VIEW ${this.viewName.trim()} AS\nSELECT /* column_list */ FROM /* table_name */`;
      Driver.createSQLTextDocument(scaffold);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to fetch view definition: ${err}`);
    }
  }

  public async dropView() {
    logger.info("Drop View");
    Driver.runQuery(dropViewQuery(this.getViewName()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop view: ${err}`);
      });
  }

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getViewDefinitionQuery(this.viewName.trim(), this.schema));
      const source = rows[0]?.VIEW_SOURCE ?? "";
      await Driver.createSQLTextDocument(buildViewCreateDDL({ name: this.viewName.trim(), source }));
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not script ${this.viewName.trim()} as CREATE: ${err?.message ?? err}`);
    }
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropViewQuery(this.getViewName()));
  }

  /** Shows this view's grants (RDB$USER_PRIVILEGES) in the results grid. */
  public async showPrivileges() {
    logger.info("Custom Query: Show Object Privileges");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(getObjectPrivilegesQuery(this.viewName.trim(), {schema: this.schema}), this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to fetch privileges: ${err}`);
      });
  }
}

class NodeViewColumn implements FirebirdTree {
  constructor(private readonly col: any) {}

  public getTreeItem(_context: ExtensionContext): TreeItem {
    const name = this.col.FIELD_NAME ? this.col.FIELD_NAME.trim() : "";
    const type = this.col.FIELD_TYPE ? this.col.FIELD_TYPE.trim() : "UNKNOWN";
    const length = this.col.FIELD_LENGTH || 0;
    return {
      label: `${name} : ${type} (${length})`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "viewColumn",
      tooltip: `${name}\n${type} (${length})\n${this.col.NOT_NULL ? "NOT NULL" : "NULL"}`
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }
}

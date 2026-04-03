import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {viewColumnsQuery, selectAllRecordsQuery, getViewDefinitionQuery, dropViewQuery} from "../shared/queries";
import {Global} from "../shared/global";
import {Driver} from "../shared/driver";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";

export class NodeView implements FirebirdTree {
  constructor(private readonly dbDetails: ConnectionOptions, private readonly viewName: string) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: this.viewName.trim(),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "view",
      tooltip: `[VIEW] ${this.viewName.trim()}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "view-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "view-light.svg")
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    const qry = viewColumnsQuery(this.viewName.trim());
    try {
      const connection = await Driver.client.createConnection(this.dbDetails);
      const columns = await Driver.client.queryPromise<any[]>(connection, qry);
      return columns.map(col => new NodeViewColumn(col));
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }

  public async selectAllRecords() {
    logger.info("Custom Query: Select All View Records");
    const qry = selectAllRecordsQuery(this.viewName.trim());
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(qry, this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
      });
  }

  public async editView() {
    logger.info("Edit View: open definition for editing");
    try {
      const connection = await Driver.client.createConnection(this.dbDetails);
      const rows = await Driver.client.queryPromise<any>(connection, getViewDefinitionQuery(this.viewName.trim()));
      const source = rows[0]?.VIEW_SOURCE ?? "";
      const scaffold = source
        ? `ALTER VIEW ${this.viewName.trim()} AS\n${source.trim()}`
        : `ALTER VIEW ${this.viewName.trim()} AS\nSELECT /* column_list */ FROM /* table_name */`;
      Driver.createSQLTextDocument(scaffold);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to fetch view definition: ${err}`);
    }
  }

  public async dropView() {
    logger.info("Drop View");
    Driver.runQuery(dropViewQuery(this.viewName.trim()), this.dbDetails)
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

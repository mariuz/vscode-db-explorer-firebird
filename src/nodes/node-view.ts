import {ExtensionContext, TreeItem, TreeItemCollapsibleState} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {viewColumnsQuery, selectAllRecordsQuery} from "../shared/queries";
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

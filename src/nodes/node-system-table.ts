import {TreeItem, TreeItemCollapsibleState, Uri, ExtensionContext} from "vscode";
import {join} from "path";
import {NodeField, NodeInfo} from ".";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {selectAllRecordsQuery, tableInfoQuery} from "../shared/queries";
import {getOptions} from "../config";
import {Global} from "../shared/global";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";

/**
 * A read-only counterpart to NodeTable for Firebird's own RDB$ system/metadata tables (shown
 * only when firebird.showSystemObjects is enabled). Supports browsing columns and selecting
 * records like a regular table, but intentionally has no drop/mock-data actions — Firebird
 * rejects DDL against system relations anyway, and offering it would be misleading.
 */
export class NodeSystemTable implements FirebirdTree {
  constructor(private readonly dbDetails: ConnectionOptions, private readonly table: string) {}

  public getTableName(): string {
    return this.table.trim();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.table.trim();
    return {
      label: name,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "systemTable",
      tooltip: `[SYSTEM TABLE] ${name}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "system-table-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "system-table-light.svg"))
      }
    };
  }

  public async getChildren(): Promise<any> {
    const qry = tableInfoQuery(this.table);

    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const fields = await Driver.client.queryPromise<any[]>(connection, qry);
      return fields.map<NodeField>(field => new NodeField(field, this.table, this.dbDetails));
    } catch (err) {
      logger.error(err);
      logger.showError(err);
      return [new NodeInfo(String(err))];
    }
  }

  public async showTableInfo() {
    logger.info("Custom Query: Show System Table Info");
    const qry = tableInfoQuery(this.table.trim());
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(qry, this.dbDetails)
      .then(result => result)
      .catch(error => Promise.reject(error));
  }

  public async selectAllRecords() {
    logger.info("Custom Query: Select All System Table Records");
    const qry = selectAllRecordsQuery(this.table.trim(), getOptions().maxResultRows);
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(qry, this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
      });
  }
}

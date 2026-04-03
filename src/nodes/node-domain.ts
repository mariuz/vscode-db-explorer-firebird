import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropDomainQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";

export class NodeDomain implements FirebirdTree {
  constructor(private readonly domain: any, private readonly dbDetails?: ConnectionOptions) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.domain.DOMAIN_NAME ? this.domain.DOMAIN_NAME.trim() : "";
    const type = this.domain.DOMAIN_TYPE ? this.domain.DOMAIN_TYPE.trim() : "UNKNOWN";
    const length = this.domain.FIELD_LENGTH || 0;
    const notNull = this.domain.NOT_NULL ? "NOT NULL" : "NULL";
    return {
      label: `${name} : ${type} (${length})`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "domain",
      tooltip: `[DOMAIN] ${name}\n${type} (${length})\n${notNull}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "domain-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "domain-light.svg")
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public async dropDomain() {
    if (!this.dbDetails) { return; }
    const name = this.domain.DOMAIN_NAME ? this.domain.DOMAIN_NAME.trim() : "";
    logger.info("Drop Domain");
    Driver.runQuery(dropDomainQuery(name), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop domain: ${err}`);
      });
  }
}

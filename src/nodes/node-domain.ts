import {ExtensionContext, TreeItem, TreeItemCollapsibleState} from "vscode";
import {join} from "path";
import {FirebirdTree} from "../interfaces";

export class NodeDomain implements FirebirdTree {
  constructor(private readonly domain: any) {}

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
}

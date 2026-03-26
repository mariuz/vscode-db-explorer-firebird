import {ExtensionContext, TreeItem, TreeItemCollapsibleState} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";

export class NodeCategoryFolder implements FirebirdTree {
  constructor(
    private readonly label: string,
    private readonly category: string,
    private readonly dbDetails: ConnectionOptions,
    private readonly childFactory: (dbDetails: ConnectionOptions) => Promise<FirebirdTree[]>
  ) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: this.label,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: `folder.${this.category}`,
      tooltip: this.label,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "folder-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "folder-light.svg")
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    try {
      return await this.childFactory(this.dbDetails);
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }
}

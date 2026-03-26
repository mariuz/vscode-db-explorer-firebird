import {ExtensionContext, TreeItem, TreeItemCollapsibleState} from "vscode";
import {join} from "path";
import {FirebirdTree} from "../interfaces";

export class NodeGenerator implements FirebirdTree {
  constructor(private readonly generatorName: string) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: this.generatorName.trim(),
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "generator",
      tooltip: `[GENERATOR] ${this.generatorName.trim()}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "generator-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "generator-light.svg")
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }
}

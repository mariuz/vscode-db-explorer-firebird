import {ExtensionContext, TreeItem, TreeItemCollapsibleState} from "vscode";
import {join} from "path";
import {FirebirdTree} from "../interfaces";

export class NodeTrigger implements FirebirdTree {
  constructor(private readonly trigger: any) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    const tableName = this.trigger.TABLE_NAME ? this.trigger.TABLE_NAME.trim() : "";
    const inactive = this.trigger.INACTIVE === 1;
    const typeDesc = this.parseTriggerType(this.trigger.TRIGGER_TYPE);
    return {
      label: `${name}${inactive ? " (inactive)" : ""}`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "trigger",
      tooltip: `[TRIGGER] ${name}\nTable: ${tableName}\nType: ${typeDesc}\n${inactive ? "INACTIVE" : "ACTIVE"}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "trigger-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "trigger-light.svg")
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  private parseTriggerType(type: number): string {
    // Firebird trigger types: 1=BEFORE INSERT, 2=AFTER INSERT, 3=BEFORE UPDATE,
    // 4=AFTER UPDATE, 5=BEFORE DELETE, 6=AFTER DELETE
    switch (type) {
      case 1: return "BEFORE INSERT";
      case 2: return "AFTER INSERT";
      case 3: return "BEFORE UPDATE";
      case 4: return "AFTER UPDATE";
      case 5: return "BEFORE DELETE";
      case 6: return "AFTER DELETE";
      default: return `TYPE ${type}`;
    }
  }
}

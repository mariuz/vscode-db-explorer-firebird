import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getTriggerBodyQuery, dropTriggerQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";

export class NodeTrigger implements FirebirdTree {
  constructor(private readonly trigger: any, private readonly dbDetails?: ConnectionOptions) {}

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

  public async editTrigger() {
    if (!this.dbDetails) { return; }
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    logger.info("Edit Trigger: open source for editing");
    try {
      const connection = await Driver.client.createConnection(this.dbDetails);
      const rows = await Driver.client.queryPromise<any>(connection, getTriggerBodyQuery(name));
      const source = rows[0]?.TRIGGER_SOURCE ?? "";
      const scaffold = source
        ? `ALTER TRIGGER ${name}\n${source.trim()}`
        : `ALTER TRIGGER ${name}\nACTIVE BEFORE INSERT ON /* table_name */\nAS\nBEGIN\n  /* trigger body */\nEND`;
      Driver.createSQLTextDocument(scaffold);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to fetch trigger source: ${err}`);
    }
  }

  public async dropTrigger() {
    if (!this.dbDetails) { return; }
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    logger.info("Drop Trigger");
    Driver.runQuery(dropTriggerQuery(name), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop trigger: ${err}`);
      });
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

import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {schemaDisplayName} from "../shared/schema-support";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getTriggerBodyQuery, dropTriggerQuery, createTriggerScaffold} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {withTruncationWarning} from "../shared/utils";
import {buildTriggerCreateDDL, describeTriggerType} from "../database-projects/project-model";

export class NodeTrigger implements FirebirdTree {
  constructor(private readonly trigger: any, private readonly dbDetails?: ConnectionOptions) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    // Qualified only when the object sits outside the default schema — see schemaDisplayName().
    const name = schemaDisplayName(this.trigger.SCHEMA_NAME, this.trigger.TRIGGER_NAME ?? "");
    const tableName = this.trigger.TABLE_NAME ? this.trigger.TABLE_NAME.trim() : "";
    const inactive = this.trigger.INACTIVE === 1;
    const typeDesc = describeTriggerType(this.trigger.TRIGGER_TYPE);
    return {
      label: `${name}${inactive ? " (inactive)" : ""}`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "trigger",
      tooltip: `[TRIGGER] ${name}\nTable: ${tableName}\nType: ${typeDesc}\n${inactive ? "INACTIVE" : "ACTIVE"}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "trigger-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "trigger-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public static createTrigger(triggerName: string): void {
    logger.info("Create Trigger: open scaffold for editing");
    Driver.createSQLTextDocument(createTriggerScaffold(triggerName.trim()));
  }

  public async editTrigger() {
    if (!this.dbDetails) { return; }
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    logger.info("Edit Trigger: open source for editing");
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getTriggerBodyQuery(name));
      const source = rows[0]?.TRIGGER_SOURCE ?? "";
      const scaffold = source
        ? withTruncationWarning(source, `ALTER TRIGGER ${name}\n${source.trim()}`)
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

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    if (!this.dbDetails) { return; }
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getTriggerBodyQuery(name));
      const source = rows[0]?.TRIGGER_SOURCE ?? "";
      await Driver.createSQLTextDocument(buildTriggerCreateDDL({
        name, source, table: this.trigger.TABLE_NAME ?? "", inactive: this.trigger.INACTIVE === 1,
        type: this.trigger.TRIGGER_TYPE ?? 0,
      }));
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not script ${name} as CREATE: ${err?.message ?? err}`);
    }
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    const name = this.trigger.TRIGGER_NAME ? this.trigger.TRIGGER_NAME.trim() : "";
    await Driver.createSQLTextDocument(dropTriggerQuery(name));
  }
}

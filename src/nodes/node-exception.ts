import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {schemaDisplayName} from "../shared/schema-support";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropExceptionQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {buildExceptionCreateDDL} from "../script-as/ddl-builders";

export class NodeException implements FirebirdTree {
  constructor(private readonly exception: any, private readonly dbDetails?: ConnectionOptions, private readonly labelSchema?: string) {}

  public getExceptionName(): string {
    return this.exception.EXCEPTION_NAME ? String(this.exception.EXCEPTION_NAME).trim() : "";
  }

  /** Display name: qualified only when the exception sits outside the default schema. */
  private getDisplayName(): string {
    return schemaDisplayName(this.exception.SCHEMA_NAME, this.getExceptionName(), this.labelSchema);
  }

  private getMessage(): string {
    return this.exception.MESSAGE ? String(this.exception.MESSAGE).trim() : "";
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    const name = this.getDisplayName();
    const message = this.getMessage();
    return {
      label: name,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "exception",
      tooltip: `[EXCEPTION] ${name}${message ? `\n${message}` : ""}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "exception-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "exception-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public async dropException() {
    if (!this.dbDetails) { return; }
    logger.info("Drop Exception");
    Driver.runQuery(dropExceptionQuery(this.getExceptionName()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop exception: ${err}`);
      });
  }

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    await Driver.createSQLTextDocument(buildExceptionCreateDDL({ name: this.getExceptionName(), message: this.getMessage() }));
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropExceptionQuery(this.getExceptionName()));
  }
}

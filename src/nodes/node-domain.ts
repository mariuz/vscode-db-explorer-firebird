import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {schemaDisplayName} from "../shared/schema-support";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropDomainQuery, createDomainScaffold, alterDomainScaffold} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {buildDomainCreateDDL} from "../script-as/ddl-builders";

export class NodeDomain implements FirebirdTree {
  constructor(private readonly domain: any, private readonly dbDetails?: ConnectionOptions) {}

  public getDragIdentifier(): string {
    return this.domain.DOMAIN_NAME ? this.domain.DOMAIN_NAME.trim() : "";
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    // Qualified only when the object sits outside the default schema — see schemaDisplayName().
    const name = schemaDisplayName(this.domain.SCHEMA_NAME, this.domain.DOMAIN_NAME ?? "");
    const type = this.domain.DOMAIN_TYPE ? this.domain.DOMAIN_TYPE.trim() : "UNKNOWN";
    const length = this.domain.FIELD_LENGTH || 0;
    const notNull = this.domain.NOT_NULL ? "NOT NULL" : "NULL";
    return {
      label: `${name} : ${type} (${length})`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "domain",
      tooltip: `[DOMAIN] ${name}\n${type} (${length})\n${notNull}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "domain-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "domain-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public static createDomain(domainName: string): void {
    logger.info("Create Domain: open scaffold for editing");
    Driver.createSQLTextDocument(createDomainScaffold(domainName.trim()));
  }

  public async alterDomain() {
    logger.info("Alter Domain: open scaffold for editing");
    Driver.createSQLTextDocument(alterDomainScaffold(this.domain));
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

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    await Driver.createSQLTextDocument(buildDomainCreateDDL(this.domain));
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    const name = this.domain.DOMAIN_NAME ? this.domain.DOMAIN_NAME.trim() : "";
    await Driver.createSQLTextDocument(dropDomainQuery(name));
  }
}

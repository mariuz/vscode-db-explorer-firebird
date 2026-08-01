import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, window, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropGeneratorQuery, setGeneratorValueQuery, createGeneratorQuery} from "../shared/queries";
import {schemaDisplayName, schemaQualifiedName} from "../shared/schema-support";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import {buildGeneratorCreateDDL} from "../database-projects/project-model";

export class NodeGenerator implements FirebirdTree {
  /** @param schema Firebird 6+ only — see NodeTable. */
  constructor(
    private readonly generatorName: string,
    private readonly dbDetails?: ConnectionOptions,
    private readonly schema?: string
  ) {}

  /** The name to put in SQL: qualified whenever a schema is known. */
  public getGeneratorName(): string {
    return schemaQualifiedName(this.schema, this.generatorName);
  }

  public getDragIdentifier(): string {
    return this.generatorName.trim();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: schemaDisplayName(this.schema, this.generatorName),
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "generator",
      tooltip: `[GENERATOR] ${this.generatorName.trim()}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "generator-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "generator-light.svg"))
      }
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }

  public static async createGenerator(dbDetails: ConnectionOptions, generatorName: string): Promise<void> {
    logger.info("Create Generator");
    return Driver.runQuery(createGeneratorQuery(generatorName.trim()), dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to create generator: ${err}`);
      });
  }

  public async dropGenerator() {
    if (!this.dbDetails) { return; }
    logger.info("Drop Generator");
    Driver.runQuery(dropGeneratorQuery(this.generatorName.trim()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop generator: ${err}`);
      });
  }

  public async setGeneratorValue() {
    if (!this.dbDetails) { return; }
    const input = await window.showInputBox({
      prompt: `Set new value for generator ${this.generatorName.trim()}`,
      placeHolder: "e.g. 0",
      validateInput: v => isNaN(Number(v)) ? "Please enter a valid integer" : undefined
    });
    if (input === undefined) { return; }
    const value = parseInt(input, 10);
    Driver.runQuery(setGeneratorValueQuery(this.generatorName.trim(), value), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to set generator value: ${err}`);
      });
  }

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    await Driver.createSQLTextDocument(buildGeneratorCreateDDL(this.generatorName.trim()));
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropGeneratorQuery(this.generatorName.trim()));
  }
}

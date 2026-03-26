import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, window} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {dropGeneratorQuery, setGeneratorValueQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";

export class NodeGenerator implements FirebirdTree {
  constructor(private readonly generatorName: string, private readonly dbDetails?: ConnectionOptions) {}

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
}

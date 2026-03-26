import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {procedureParametersQuery, getProcedureBodyQuery, dropProcedureQuery} from "../shared/queries";
import {Driver} from "../shared/driver";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";

export class NodeProcedure implements FirebirdTree {
  constructor(private readonly dbDetails: ConnectionOptions, private readonly procedureName: string) {}

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: this.procedureName.trim(),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "procedure",
      tooltip: `[PROCEDURE] ${this.procedureName.trim()}`,
      iconPath: {
        dark: join(context.extensionPath, "resources", "icons", "dark", "procedure-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "procedure-light.svg")
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    const qry = procedureParametersQuery(this.procedureName.trim());
    try {
      const connection = await Driver.client.createConnection(this.dbDetails);
      const params = await Driver.client.queryPromise<any[]>(connection, qry);
      return params.map(param => new NodeProcedureParam(param));
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }

  public async editProcedure() {
    logger.info("Edit Procedure: open source for editing");
    try {
      const connection = await Driver.client.createConnection(this.dbDetails);
      const rows = await Driver.client.queryPromise<any>(connection, getProcedureBodyQuery(this.procedureName.trim()));
      const source = rows[0]?.PROCEDURE_SOURCE ?? "";
      const scaffold = source
        ? `ALTER PROCEDURE ${this.procedureName.trim()}\n${source.trim()}`
        : `ALTER PROCEDURE ${this.procedureName.trim()}\nAS\nBEGIN\n  /* procedure body */\nEND`;
      Driver.createSQLTextDocument(scaffold);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to fetch procedure source: ${err}`);
    }
  }

  public async dropProcedure() {
    logger.info("Drop Procedure");
    Driver.runQuery(dropProcedureQuery(this.procedureName.trim()), this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to drop procedure: ${err}`);
      });
  }
}

class NodeProcedureParam implements FirebirdTree {
  constructor(private readonly param: any) {}

  public getTreeItem(_context: ExtensionContext): TreeItem {
    const name = this.param.PARAM_NAME ? this.param.PARAM_NAME.trim() : "";
    const direction = this.param.PARAM_TYPE === 0 ? "IN" : "OUT";
    const type = this.param.FIELD_TYPE ? this.param.FIELD_TYPE.trim() : "UNKNOWN";
    const length = this.param.FIELD_LENGTH || 0;
    return {
      label: `${name} : ${type} (${length}) [${direction}]`,
      collapsibleState: TreeItemCollapsibleState.None,
      contextValue: "procedureParam",
      tooltip: `${name}\n${type} (${length})\nDirection: ${direction}`
    };
  }

  public getChildren(): FirebirdTree[] {
    return [];
  }
}

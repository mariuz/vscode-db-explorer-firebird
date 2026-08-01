import {ExtensionContext, TreeItem, TreeItemCollapsibleState, commands, Uri} from "vscode";
import {join} from "path";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {procedureParametersQuery, getProcedureBodyQuery, dropProcedureQuery, createProcedureScaffold, getObjectPrivilegesQuery} from "../shared/queries";
import {schemaDisplayName, schemaQualifiedName} from "../shared/schema-support";
import {Global} from "../shared/global";
import {Driver} from "../shared/driver";
import {NodeInfo} from "./node-info";
import {logger} from "../logger/logger";
import {withTruncationWarning} from "../shared/utils";
import {buildProcedureCreateDDL, buildProcedureParameterHeader, ProcedureParameter} from "../database-projects/project-model";

export class NodeProcedure implements FirebirdTree {
  /** @param schema Firebird 6+ only — see NodeTable. */
  constructor(
    private readonly dbDetails: ConnectionOptions,
    private readonly procedureName: string,
    private readonly schema?: string
  ) {}

  /** The name to put in SQL: qualified whenever a schema is known. */
  public getProcedureName(): string {
    return schemaQualifiedName(this.schema, this.procedureName);
  }

  public getDragIdentifier(): string {
    return this.procedureName.trim();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: schemaDisplayName(this.schema, this.procedureName),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "procedure",
      tooltip: `[PROCEDURE] ${this.procedureName.trim()}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "procedure-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "procedure-light.svg"))
      }
    };
  }

  public async getChildren(): Promise<FirebirdTree[]> {
    const qry = procedureParametersQuery(this.procedureName.trim(), this.schema);
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const params = await Driver.client.queryPromise<any[]>(connection, qry);
      return params.map(param => new NodeProcedureParam(param));
    } catch (err) {
      logger.error(err);
      return [new NodeInfo(String(err))];
    }
  }

  public static createProcedure(procedureName: string): void {
    logger.info("Create Procedure: open scaffold for editing");
    Driver.createSQLTextDocument(createProcedureScaffold(procedureName.trim()));
  }

  /** Fetches this procedure's parameters via the given (already-open) connection, in ProcedureParameter shape. */
  private async fetchParameters(connection: any): Promise<ProcedureParameter[]> {
    const paramRows = await Driver.client.queryPromise<any>(connection, procedureParametersQuery(this.procedureName.trim(), this.schema));
    return paramRows.map((r: any) => ({
      name: r.PARAM_NAME.trim(),
      direction: r.PARAM_TYPE === 1 ? "out" : "in",
      type: r.FIELD_TYPE.trim(),
      length: r.FIELD_LENGTH ?? 0,
      subType: r.FIELD_SUB_TYPE ?? undefined,
      precision: r.FIELD_PRECISION ?? undefined,
      scale: r.FIELD_SCALE ?? undefined,
    }));
  }

  public async editProcedure() {
    logger.info("Edit Procedure: open source for editing");
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getProcedureBodyQuery(this.procedureName.trim(), this.schema));
      const source = rows[0]?.PROCEDURE_SOURCE ?? "";
      const parameters = await this.fetchParameters(connection);
      // RDB$PROCEDURE_SOURCE never includes the "AS" keyword (unlike RDB$TRIGGER_SOURCE), confirmed
      // directly against a live server — it must always be reinserted here. Unlike ALTER TRIGGER,
      // a plain ALTER PROCEDURE also genuinely requires re-specifying the full parameter list even
      // for a body-only edit (also confirmed live) — omitting it makes every parameter "unknown"
      // inside the new body.
      const header = buildProcedureParameterHeader(parameters);
      const headerPart = header ? `\n${header}` : "";
      const scaffold = source
        ? withTruncationWarning(source, `ALTER PROCEDURE ${this.procedureName.trim()}${headerPart}\nAS\n${source.trim()}`)
        : `ALTER PROCEDURE ${this.procedureName.trim()}\nAS\nBEGIN\n  /* procedure body */\nEND`;
      Driver.createSQLTextDocument(scaffold);
    } catch (err) {
      logger.error(err);
      logger.showError(`Failed to fetch procedure source: ${err}`);
    }
  }

  public async dropProcedure() {
    logger.info("Drop Procedure");
    Driver.runQuery(dropProcedureQuery(this.getProcedureName()), this.dbDetails)
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

  /** Generic "Script as Create". */
  public async scriptAsCreate(): Promise<void> {
    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const rows = await Driver.client.queryPromise<any>(connection, getProcedureBodyQuery(this.procedureName.trim(), this.schema));
      const source = rows[0]?.PROCEDURE_SOURCE ?? "";
      const parameters = await this.fetchParameters(connection);
      await Driver.createSQLTextDocument(buildProcedureCreateDDL({ name: this.procedureName.trim(), source, parameters }));
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not script ${this.procedureName.trim()} as CREATE: ${err?.message ?? err}`);
    }
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropProcedureQuery(this.getProcedureName()));
  }

  /** Shows this procedure's grants (RDB$USER_PRIVILEGES) in the results grid. */
  public async showPrivileges() {
    logger.info("Custom Query: Show Object Privileges");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(getObjectPrivilegesQuery(this.procedureName.trim()), this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to fetch privileges: ${err}`);
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

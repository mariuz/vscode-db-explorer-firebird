import {TreeItem, TreeItemCollapsibleState, commands, Uri, ExtensionContext} from "vscode";
import {join} from "path";
import {NodeField, NodeInfo, NodeIndexFolder} from ".";
import {ConnectionOptions, FirebirdTree, Options} from "../interfaces";
import {selectAllRecordsQuery, tableInfoQuery, dropTableQuery, getForeignKeysQuery, getObjectPrivilegesQuery} from "../shared/queries";
import {getOptions} from "../config";
import {schemaDisplayName, schemaQualifiedName} from "../shared/schema-support";
import {Global} from "../shared/global";
import {Driver} from "../shared/driver";
import {logger} from "../logger/logger";
import MockData, {MockField} from "../mock-data/mock-data";
import {SchemaDesigner} from "../schema-designer";
import {tableInfoRowsToTable} from "../script-as/ddl-builders";
import {buildTableCreateDDL, buildForeignKeyDDL} from "../database-projects/project-model";

export class NodeTable implements FirebirdTree {
  /**
   * @param schema Firebird 6+ only, and only when the server reported one. Left undefined on
   *   pre-6 servers, where schemas do not exist — which keeps every name this class produces
   *   byte-identical to what it produced before schemas were understood at all.
   */
  constructor(
    private readonly dbDetails: ConnectionOptions,
    private readonly table: string,
    private readonly schema?: string
  ) {}

  /**
   * The name to put in SQL. Qualified whenever a schema is known, including `PUBLIC`: leaving it
   * to the session's search path is exactly how an action ends up hitting the wrong one of two
   * same-named tables.
   */
  public getTableName(): string {
    return schemaQualifiedName(this.schema, this.table);
  }

  /** Bare relation name, for metadata lookups that match on `RDB$RELATION_NAME`. */
  public getRelationName(): string {
    return this.table.trim();
  }

  public getDragIdentifier(): string {
    return this.getTableName();
  }

  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      // Objects in the default schema keep their bare name so a single-schema database (which is
      // every Firebird 6 database until someone runs CREATE SCHEMA) looks exactly as before.
      label: schemaDisplayName(this.schema, this.table),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "table",
      tooltip: `[TABLE] ${this.table}`,
      iconPath: {
        dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "table-dark.svg")),
        light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "table-light.svg"))
      }
    };
  }

  public async getChildren(): Promise<any> {
    const qry = tableInfoQuery(this.table);

    try {
      const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
      const fields = await Driver.client.queryPromise<any[]>(connection, qry);
      const fieldNodes = fields.map<NodeField>(field => {
        return new NodeField(field, this.table, this.dbDetails);
      });
      return [...fieldNodes, new NodeIndexFolder(this.dbDetails, this.table)];
    } catch (err) {
      logger.error(err);
      logger.showError(err);
      return [new NodeInfo(String(err))];
    }
  }

  //  run predefined sql query
  public async showTableInfo() {
    logger.info("Custom Query: Show Table Info");

    const qry = tableInfoQuery(this.table.trim());

    Global.activeConnection = this.dbDetails;

    return Driver.runQuery(qry, this.dbDetails)
      .then(result => {
        return result;
      })
      .catch(error => {
        return Promise.reject(error);
      });
  }

  //  run predefined sql query
  public async selectAllRecords() {
    logger.info("Custom Query: Select All Records");

    const qry = selectAllRecordsQuery(this.getTableName(), getOptions().maxResultRows);
    Global.activeConnection = this.dbDetails;

    return Driver.runQuery(qry, this.dbDetails)
      .then(result => {
        return result;
      })
      .catch(err => {
        logger.error(err);
      });
  }

  public async dropTable() {
    logger.info("Custom Query: Drop Table");

    const qry = dropTableQuery(this.getTableName());
    Global.activeConnection = this.dbDetails;

    Driver.runQuery(qry, this.dbDetails)
      .then(results => {
        logger.info(results[0].message);
        logger.showInfo(results[0].message);
        commands.executeCommand("firebird.explorer.refresh");
      })
      .catch(err => {
        logger.error(err);
      });
  }

  public alterTable(schemaDesigner: SchemaDesigner): void {
    logger.info("Alter Table: open Schema Designer, focused on this table");
    schemaDesigner.openForAlterTable(this.dbDetails, this.table.trim());
  }

  /** Generic "Script as Create": reconstructs this table's CREATE TABLE (plus any foreign keys it owns) for review. */
  public async scriptAsCreate(): Promise<void> {
    const tableName = this.table.trim();
    const connection = await Driver.client.createConnection(await Driver.resolvePassword(this.dbDetails));
    try {
      const columnRows = await Driver.client.queryPromise<any>(connection, tableInfoQuery(tableName));
      const fkRows = await Driver.client.queryPromise<any>(connection, getForeignKeysQuery());
      const table = tableInfoRowsToTable(tableName, columnRows);
      const ddl = [buildTableCreateDDL(table)];
      fkRows
        .filter((row: any) => row.TABLE_NAME.trim() === tableName)
        .forEach((row: any) => {
          ddl.push(buildForeignKeyDDL({
            constraintName: row.CONSTRAINT_NAME.trim(),
            table: row.TABLE_NAME.trim(),
            column: row.COLUMN_NAME.trim(),
            refTable: row.REF_TABLE_NAME.trim(),
            refColumn: row.REF_COLUMN_NAME.trim(),
          }));
        });
      await Driver.createSQLTextDocument(ddl.join("\n\n"));
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not script ${tableName} as CREATE: ${err?.message ?? err}`);
    } finally {
      await Driver.client.detach(connection);
    }
  }

  /** Generic "Script as Drop". */
  public async scriptAsDrop(): Promise<void> {
    await Driver.createSQLTextDocument(dropTableQuery(this.getTableName()));
  }

  /** Shows this table's grants (RDB$USER_PRIVILEGES) in the results grid. */
  public async showPrivileges() {
    logger.info("Custom Query: Show Object Privileges");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(getObjectPrivilegesQuery(this.table.trim()), this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
        logger.showError(`Failed to fetch privileges: ${err}`);
      });
  }

  public async generateMockData(firebirdMockData: MockData, config: Options) {
    const fields: MockField[] = [];
    const apiKey = config.mockarooApiKey;

    if (!apiKey) {
      logger.error(
        "No Mockaroo Api key detected!\nTo generate your API key, create an account at https://www.mockaroo.com/ and insert your API key in extension settings."
      );
      await logger
        .showError("No Mockaroo API key in settings! Unable to generate mock data.", ["Cancel", "Get API key"])
        .then(selected => {
          if (selected === "Get API key") {
            commands.executeCommand("vscode.open", Uri.parse("https://www.mockaroo.com/users/sign_up"));
          }
        });
      return;
    }

    await this.getChildren().then(children => {
      children
        .filter((child: any) => child instanceof NodeField)
        .forEach((data: any) => {
          fields.push({
            name: data.field.FIELD_NAME.trim(),
            type: data.field.FIELD_TYPE.trim() + " (" + data.field.FIELD_LENGTH + ")",
            notnull: data.field.NOT_NULL
          });
        });
    });

    firebirdMockData.display(this.table, fields, apiKey);
  }
}

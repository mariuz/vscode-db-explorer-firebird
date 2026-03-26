import {ExtensionContext, TreeItem, TreeItemCollapsibleState, window} from "vscode";
import {join} from "path";
import {NodeTable, NodeCategoryFolder, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain} from "./";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getOptions, Constants} from "../config";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {FirebirdTreeDataProvider} from "../firebirdTreeDataProvider";
import {databaseInfoQry, getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery, getGeneratorsQuery, getDomainsQuery, monitorConnectionsQuery} from "../shared/queries";
import {logger} from "../logger/logger";
import * as cp from 'node:child_process';


export class NodeDatabase implements FirebirdTree {

  constructor(private readonly dbDetails: ConnectionOptions) {}

  // list databases grouped by host names
  public getTreeItem(context: ExtensionContext): TreeItem {
    return {
      label: this.dbDetails.database
        .split("\\")
        .pop()
        .split("/")
        .pop(),
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "database",
      tooltip: `[DATABASE] ${this.dbDetails.database}`,
      iconPath: {
        /* dark: join(__filename, "..", "..", "..", "resources", "icons", "dark", "db-dark.svg"),
        light: join(__filename, "..", "..", "..", "resources", "icons", "light", "db-light.svg") */
        dark: join(context.extensionPath, "resources", "icons", "dark", "db-dark.svg"),
        light: join(context.extensionPath, "resources", "icons", "light", "db-light.svg")
      }
    };
  }

  // list database object categories
  public async getChildren(): Promise<FirebirdTree[]> {
    return [
      new NodeCategoryFolder("Tables", "tables", this.dbDetails, this.getTableChildren.bind(this)),
      new NodeCategoryFolder("Views", "views", this.dbDetails, this.getViewChildren.bind(this)),
      new NodeCategoryFolder("Stored Procedures", "procedures", this.dbDetails, this.getProcedureChildren.bind(this)),
      new NodeCategoryFolder("Triggers", "triggers", this.dbDetails, this.getTriggerChildren.bind(this)),
      new NodeCategoryFolder("Generators", "generators", this.dbDetails, this.getGeneratorChildren.bind(this)),
      new NodeCategoryFolder("Domains", "domains", this.dbDetails, this.getDomainChildren.bind(this)),
    ];
  }

  private async getTableChildren(): Promise<FirebirdTree[]> {
    const tablesQry = getTablesQuery(getOptions().maxTablesCount);
    const connection = await Driver.client.createConnection(this.dbDetails);
    const tables = await Driver.client.queryPromise<any>(connection, tablesQry);
    return tables.map<NodeTable>(table => new NodeTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getViewChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(this.dbDetails);
    const views = await Driver.client.queryPromise<any>(connection, getViewsQuery());
    return views.map<NodeView>(view => new NodeView(this.dbDetails, view.VIEW_NAME));
  }

  private async getProcedureChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(this.dbDetails);
    const procs = await Driver.client.queryPromise<any>(connection, getStoredProceduresQuery());
    return procs.map<NodeProcedure>(proc => new NodeProcedure(this.dbDetails, proc.PROCEDURE_NAME));
  }

  private async getTriggerChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(this.dbDetails);
    const triggers = await Driver.client.queryPromise<any>(connection, getTriggersQuery());
    return triggers.map<NodeTrigger>(trigger => new NodeTrigger(trigger, this.dbDetails));
  }

  private async getGeneratorChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(this.dbDetails);
    const generators = await Driver.client.queryPromise<any>(connection, getGeneratorsQuery());
    return generators.map<NodeGenerator>(gen => new NodeGenerator(gen.GENERATOR_NAME, this.dbDetails));
  }

  private async getDomainChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(this.dbDetails);
    const domains = await Driver.client.queryPromise<any>(connection, getDomainsQuery());
    return domains.map<NodeDomain>(domain => new NodeDomain(domain, this.dbDetails));
  }

  //  run predefined sql query
  public async showDatabaseInfo() {
    logger.info("Custom query: Show Database Info");

    const qry = databaseInfoQry;
    Global.activeConnection = this.dbDetails;

    return Driver.runQuery(qry, this.dbDetails)
      .then(result => {
        return result;
      })
      .catch(err => {
        logger.error(err);
      });
  }

  // create new sql document and set active database
  public async newQuery(): Promise<void> {
    Driver.createSQLTextDocument()
      .then(res => {
        if (res) {
          this.setActive();
          logger.info("New Firebird SQL query");
        }
      })
      .catch(err => {
        logger.error(err);
      });
  }

  // delete database connection details and remove it from explorer view
  public async removeDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider) {
    logger.info("Remove database start...");

    const connections = context.globalState.get<{[key: string]: ConnectionOptions;}>(Constants.ConectionsKey);

    if (connections) {
      delete connections[this.dbDetails.id];
      await context.globalState.update(Constants.ConectionsKey, connections);
      logger.debug(`Removed connection ${this.dbDetails.id}`);
      firebirdTreeDataProvider.refresh();
      logger.info("Remove database end...");
    }
  }

  // set active database
  public async setActive(): Promise<void> {
    logger.info("Set active connection");
    Global.activeConnection = this.dbDetails;
  }

  // monitor active connections and I/O stats
  public async monitorDatabase() {
    logger.info("Monitor Database: active connections");
    Global.activeConnection = this.dbDetails;
    return Driver.runQuery(monitorConnectionsQuery, this.dbDetails)
      .then(result => result)
      .catch(err => {
        logger.error(err);
        return Promise.reject(err);
      });
  }

  // backup database using gbak
  public async backupDatabase(): Promise<void> {
    const saveUri = await window.showSaveDialog({
      title: "Backup Firebird Database",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      defaultUri: undefined
    });
    if (!saveUri) { return; }

    const backupPath = saveUri.fsPath;
    const { host, port, database, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${database}`;
    const args = ["-b", "-user", user, "-password", password, hostPort, backupPath];

    logger.info(`Starting backup to ${backupPath}`);
    const statusItem = window.createStatusBarItem();
    statusItem.text = "$(loading~spin) Backing up database...";
    statusItem.show();

    const child = cp.execFile("gbak", args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));
    child.on("error", err => {
      statusItem.dispose();
      logger.error(`Backup error: ${err.message}`);
      logger.showError(`Backup failed: ${err.message}`);
    });
    child.on("close", code => {
      statusItem.dispose();
      if (code === 0) {
        logger.info(`Backup completed: ${backupPath}`);
        window.showInformationMessage(`Database backed up successfully to ${backupPath}`);
      } else {
        logger.error(`Backup failed with exit code ${code}`);
        logger.showError(`Backup failed (exit code ${code}). Check the log for details.`);
      }
    });
  }

  // restore database using gbak
  public async restoreDatabase(): Promise<void> {
    const openUris = await window.showOpenDialog({
      title: "Select Firebird Backup File",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      canSelectMany: false
    });
    if (!openUris || openUris.length === 0) { return; }

    const backupPath = openUris[0].fsPath;

    const restoreUri = await window.showSaveDialog({
      title: "Restore To Database File",
      filters: { "Firebird Database": ["fdb", "gdb"], "All files": ["*"] },
      defaultUri: undefined
    });
    if (!restoreUri) { return; }

    const restorePath = restoreUri.fsPath;
    const { host, port, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${restorePath}`;
    const args = ["-c", "-user", user, "-password", password, backupPath, hostPort];

    logger.info(`Starting restore from ${backupPath} to ${restorePath}`);
    const statusItem = window.createStatusBarItem();
    statusItem.text = "$(loading~spin) Restoring database...";
    statusItem.show();

    const child = cp.execFile("gbak", args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));
    child.on("error", err => {
      statusItem.dispose();
      logger.error(`Restore error: ${err.message}`);
      logger.showError(`Restore failed: ${err.message}`);
    });
    child.on("close", code => {
      statusItem.dispose();
      if (code === 0) {
        logger.info(`Restore completed: ${restorePath}`);
        window.showInformationMessage(`Database restored successfully to ${restorePath}`);
      } else {
        logger.error(`Restore failed with exit code ${code}`);
        logger.showError(`Restore failed (exit code ${code}). Check the log for details.`);
      }
    });
  }
}

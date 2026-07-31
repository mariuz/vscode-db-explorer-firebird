import {ExtensionContext, TreeItem, TreeItemCollapsibleState, window, Uri, ThemeIcon, ThemeColor, env, QuickPickItem, ProgressLocation} from "vscode";
import {join} from "path";
import {NodeTable, NodeCategoryFolder, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain, NodeRole, NodeException, NodeSystemTable, NodeUser} from "./";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getOptions, Constants} from "../config";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {CredentialStore} from "../shared/credential-store";
import {FirebirdTreeDataProvider} from "../firebirdTreeDataProvider";
import {databaseInfoQry, getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery, getGeneratorsQuery, getDomainsQuery, getRolesQuery, getExceptionsQuery, getSystemTablesQuery, getUsersQuery} from "../shared/queries";
import {logger} from "../logger/logger";
import {getDatabaseFileName} from "../shared/utils";
import {getObjectFilter, matchesObjectFilter} from "../shared/object-explorer-filter";
import {buildConnectionString} from "../shared/connection-string";
import {connectionWizard} from "../shared/connection-wizard";
import {TaskTracker} from "../task-panel/task-tracker";
import {buildBackupFlags, BackupFlagChoices, buildRestoreArgs, renderGbakCommand, RestoreFlagChoices, RestoreMode, RESTORE_PAGE_SIZES} from "../shared/gbak-options";
import {isConnectionUnreachable} from "../shared/connection-health";
import {SchemaDesigner} from "../schema-designer";
import {ProfilerView} from "../profiler";
import {runFlatFileImportWizard} from "../flat-file-import";
import {runDataApiSpecGenerator, runDataApiSpecGeneratorWithCopilot} from "../data-api-builder";
import {runExtractProject} from "../database-projects";
import {runObjectSearch} from "../object-search";
import QueryResultsView from "../result-view";
import {notifyMcpExposureChanged} from "../mcp-server";
import {themeColorIdFor, CONNECTION_COLORS, ConnectionColor} from "../shared/connection-color";
import * as cp from 'node:child_process';

/** backupDatabase()'s options QuickPick (docs/roadmap/backup-restore-options.md, phase 1). */
const BACKUP_OPTION_ITEMS: (QuickPickItem & { key: keyof BackupFlagChoices })[] = [
  { label: "Skip garbage collection", description: "Faster backup, but doesn't reclaim space", key: "skipGarbageCollection" },
  { label: "Compress backup file", description: ".zip format", key: "compress" },
  { label: "Metadata only", description: "Schema only, no table data", key: "metadataOnly" },
  { label: "Non-transportable format", description: "Faster/smaller, but only restorable on the same platform/architecture", key: "nonTransportable" },
];

/**
 * restoreDatabase()'s options QuickPick (docs/roadmap/backup-restore-options.md, phase 2).
 * "Replace an existing database" is presented as a checkbox here even though it isn't a modifier
 * flag — it switches gbak's top-level `-C`/`-REP` switch — because a separate dialog just to ask
 * "create or replace?" would be a third prompt before every restore for a question most people
 * answer the same way every time.
 */
const RESTORE_OPTION_ITEMS: (QuickPickItem & { key: keyof RestoreFlagChoices | "replace" | "pageSize" })[] = [
  { label: "Replace an existing database", description: "Otherwise the restore fails if the target file already exists", key: "replace" },
  { label: "Metadata only", description: "Schema only, no table data", key: "metadataOnly" },
  { label: "One table at a time", description: "Slower, but can get past a single unreadable table", key: "oneAtATime" },
  { label: "Skip validity conditions", description: "Don't restore NOT NULL/CHECK constraints", key: "noValidity" },
  { label: "Don't recreate shadows", description: "Restore without the database's shadow files", key: "noShadows" },
  { label: "Override page size…", description: "Pick a page size instead of the one recorded in the backup", key: "pageSize" },
];

export class NodeDatabase implements FirebirdTree {

  constructor(private readonly dbDetails: ConnectionOptions) {}

  // list databases grouped by host names
  public getTreeItem(context: ExtensionContext): TreeItem {
    const colorId = themeColorIdFor(this.dbDetails.color);
    // Connection Lost Indicator (docs/roadmap/connection-lost-indicator.md), phase 3 -- a warning
    // badge for a database node that most recently failed to expand due to a connection error,
    // cleared the moment a subsequent expand succeeds (see NodeCategoryFolder.getChildren()).
    const unreachable = isConnectionUnreachable(this.dbDetails.id);
    return {
      label: getDatabaseFileName(this.dbDetails.database),
      description: unreachable ? "⚠ connection lost" : undefined,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: "database",
      tooltip: (this.dbDetails.workspace
        ? `[DATABASE] ${this.dbDetails.database}\nFrom this workspace's .vscode/firebird.json`
        : `[DATABASE] ${this.dbDetails.database}`
      ) + (unreachable ? "\nConnection lost — expand again to retry." : ""),
      // A color tag (set via "Set Connection Color...") swaps the usual custom SVG icon for a
      // themed codicon, since TreeItem iconPath can't tint an arbitrary SVG file — untagged
      // connections keep the existing icon unchanged. An unreachable connection overrides both.
      iconPath: unreachable
        ? new ThemeIcon("debug-disconnect", new ThemeColor("errorForeground"))
        : colorId
        ? new ThemeIcon("database", new ThemeColor(colorId))
        : {
            dark: Uri.file(join(context.extensionPath, "resources", "icons", "dark", "db-dark.svg")),
            light: Uri.file(join(context.extensionPath, "resources", "icons", "light", "db-light.svg"))
          }
    };
  }

  /** Returns a copy of dbDetails with password resolved from SecretStorage if needed. */
  private async resolvedDetails(): Promise<ConnectionOptions> {
    return Driver.resolvePassword(this.dbDetails);
  }

  // list database object categories
  public async getChildren(): Promise<FirebirdTree[]> {
    const children: FirebirdTree[] = [
      new NodeCategoryFolder("Tables", "tables", this.dbDetails, this.getTableChildren.bind(this)),
      new NodeCategoryFolder("Views", "views", this.dbDetails, this.getViewChildren.bind(this)),
      new NodeCategoryFolder("Stored Procedures", "procedures", this.dbDetails, this.getProcedureChildren.bind(this)),
      new NodeCategoryFolder("Triggers", "triggers", this.dbDetails, this.getTriggerChildren.bind(this)),
      new NodeCategoryFolder("Generators", "generators", this.dbDetails, this.getGeneratorChildren.bind(this)),
      new NodeCategoryFolder("Domains", "domains", this.dbDetails, this.getDomainChildren.bind(this)),
      new NodeCategoryFolder("Roles", "roles", this.dbDetails, this.getRoleChildren.bind(this)),
      new NodeCategoryFolder("Exceptions", "exceptions", this.dbDetails, this.getExceptionChildren.bind(this)),
      new NodeCategoryFolder("Users", "users", this.dbDetails, this.getUserChildren.bind(this)),
    ];
    if (getOptions().showSystemObjects) {
      children.push(new NodeCategoryFolder("System Tables", "systemTables", this.dbDetails, this.getSystemTableChildren.bind(this)));
    }
    return children;
  }

  /** Narrows rows to those matching this category's active object filter (if any), set via NodeCategoryFolder#setFilter(). */
  private filterRows<T>(rows: T[], category: string, nameOf: (row: T) => string): T[] {
    const filter = getObjectFilter(this.dbDetails.id, category);
    if (!filter) { return rows; }
    return rows.filter(row => matchesObjectFilter(nameOf(row), filter));
  }

  private async getTableChildren(): Promise<FirebirdTree[]> {
    const tablesQry = getTablesQuery(getOptions().maxTablesCount);
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, tablesQry);
    return this.filterRows(tables, "tables", t => t.TABLE_NAME).map<NodeTable>(table => new NodeTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getViewChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const views = await Driver.client.queryPromise<any>(connection, getViewsQuery());
    return this.filterRows(views, "views", v => v.VIEW_NAME).map<NodeView>(view => new NodeView(this.dbDetails, view.VIEW_NAME));
  }

  private async getProcedureChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const procs = await Driver.client.queryPromise<any>(connection, getStoredProceduresQuery());
    return this.filterRows(procs, "procedures", p => p.PROCEDURE_NAME).map<NodeProcedure>(proc => new NodeProcedure(this.dbDetails, proc.PROCEDURE_NAME));
  }

  private async getTriggerChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const triggers = await Driver.client.queryPromise<any>(connection, getTriggersQuery());
    return this.filterRows(triggers, "triggers", t => t.TRIGGER_NAME).map<NodeTrigger>(trigger => new NodeTrigger(trigger, this.dbDetails));
  }

  private async getGeneratorChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const generators = await Driver.client.queryPromise<any>(connection, getGeneratorsQuery());
    return this.filterRows(generators, "generators", g => g.GENERATOR_NAME).map<NodeGenerator>(gen => new NodeGenerator(gen.GENERATOR_NAME, this.dbDetails));
  }

  private async getDomainChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const domains = await Driver.client.queryPromise<any>(connection, getDomainsQuery());
    return this.filterRows(domains, "domains", d => d.DOMAIN_NAME).map<NodeDomain>(domain => new NodeDomain(domain, this.dbDetails));
  }

  private async getRoleChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const roles = await Driver.client.queryPromise<any>(connection, getRolesQuery());
    return this.filterRows(roles, "roles", r => r.ROLE_NAME).map<NodeRole>(role => new NodeRole(role.ROLE_NAME, this.dbDetails));
  }

  private async getExceptionChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const exceptions = await Driver.client.queryPromise<any>(connection, getExceptionsQuery());
    return this.filterRows(exceptions, "exceptions", e => e.EXCEPTION_NAME).map<NodeException>(exception => new NodeException(exception, this.dbDetails));
  }

  private async getSystemTableChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const tables = await Driver.client.queryPromise<any>(connection, getSystemTablesQuery());
    return this.filterRows(tables, "systemTables", t => t.TABLE_NAME).map<NodeSystemTable>(table => new NodeSystemTable(this.dbDetails, table.TABLE_NAME));
  }

  private async getUserChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const users = await Driver.client.queryPromise<any>(connection, getUsersQuery());
    return this.filterRows(users, "users", u => u.USER_NAME).map<NodeUser>(user => new NodeUser(user.USER_NAME, this.dbDetails));
  }

  //  run predefined sql query
  public async showDatabaseInfo() {
    logger.info("Custom query: Show Database Info");

    const qry = databaseInfoQry;
    Global.activeConnection = await this.resolvedDetails();

    return Driver.runQuery(qry, Global.activeConnection)
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

  // open the Schema Designer (whole-database ER diagram, editable) for this database
  public openSchemaDesigner(schemaDesigner: SchemaDesigner): void {
    schemaDesigner.openFullSchema(this.dbDetails);
  }

  // guided CSV/TSV/JSON -> new table import wizard
  public async importFlatFile(): Promise<void> {
    return runFlatFileImportWizard(this.dbDetails);
  }

  // generate an OpenAPI REST spec (one CRUD route set per table) from the connected schema
  public async generateDataApiSpec(): Promise<void> {
    return runDataApiSpecGenerator(this.dbDetails);
  }

  // same, but scoped by a Copilot-interpreted plain-English description ("expose X and Y as read-only")
  public async generateDataApiSpecWithCopilot(): Promise<void> {
    return runDataApiSpecGeneratorWithCopilot(this.dbDetails);
  }

  // extract the connected schema into a folder of versioned .sql files (Database Projects)
  public async extractProject(): Promise<void> {
    return runExtractProject(this.dbDetails);
  }

  // fuzzy-search every table/view/procedure/trigger/generator/domain by name, then jump to it
  public async searchObjects(firebirdQueryResults: QueryResultsView): Promise<void> {
    return runObjectSearch(this.dbDetails, firebirdQueryResults);
  }

  /** Connection details with the password resolved from SecretStorage, for callers (e.g. the
   * isql terminal) that need the real value directly rather than going through Driver. */
  public async getResolvedConnectionDetails(): Promise<ConnectionOptions> {
    return this.resolvedDetails();
  }

  // tag this connection with a color (tree icon + status bar) for quick visual identification
  public async setConnectionColor(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const noneLabel = "$(circle-slash) None";
    const items = [
      { label: noneLabel, color: undefined as ConnectionColor | undefined },
      ...CONNECTION_COLORS.map(color => ({ label: `$(circle-large-filled) ${color[0].toUpperCase()}${color.slice(1)}`, color })),
    ];
    const picked = await window.showQuickPick(items, { title: "Set Connection Color" });
    if (!picked) { return; }

    await this.updateSavedConnectionField(context, "color", picked.color);
    firebirdTreeDataProvider.refresh();
  }

  // organize this connection under a named group/folder in the tree instead of by host
  public async setConnectionGroup(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const group = await window.showInputBox({
      title: "Set Connection Group",
      prompt: "Group/folder name to organize this connection under (leave empty to ungroup — falls back to grouping by host)",
      value: this.dbDetails.group ?? "",
    });
    if (group === undefined) { return; }

    await this.updateSavedConnectionField(context, "group", group || undefined);
    firebirdTreeDataProvider.refresh();
  }

  // opt this connection in/out of the firebird-mcp MCP server's list_connections/get_schema tools
  public async toggleMcpExposure(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }

    const nowExposed = !this.dbDetails.mcpExposed;
    await this.updateSavedConnectionField(context, "mcpExposed", nowExposed);
    if (!nowExposed && this.dbDetails.mcpWriteEnabled) {
      // Disabling base exposure also revokes write access, rather than leaving it dormant in
      // storage — re-enabling exposure later must go back through toggleMcpWriteAccess()'s own
      // confirmation, not silently reactivate a write grant set before exposure was last turned off.
      await this.updateSavedConnectionField(context, "mcpWriteEnabled", false);
    }
    firebirdTreeDataProvider.refresh();
    notifyMcpExposureChanged();
    logger.showInfo(nowExposed
      ? `${getDatabaseFileName(this.dbDetails.database)} is now exposed to the Firebird MCP server (if firebird.mcp.enabled is on).`
      : `${getDatabaseFileName(this.dbDetails.database)} is no longer exposed to the Firebird MCP server.`);
  }

  /**
   * Explicit, separate opt-in on top of toggleMcpExposure() — lets the MCP server's opt-in
   * run_write_query tool (docs/roadmap/mcp-server.md's write-query path) run a single INSERT/
   * UPDATE/DELETE against this connection, not just read it. Requires mcpExposed to already be on
   * (there's nothing to write-enable on a connection the MCP server can't even see).
   *
   * Enabling requires an explicit modal confirmation — the only point in the whole write-query
   * path where a real VS Code UI is available to ask the user, since the spawned MCP server
   * subprocess that actually runs a write has no way to show a dialog of its own (see the roadmap
   * doc's security model). Disabling never needs confirmation, matching every other permission-
   * reducing toggle in this codebase (e.g. toggleMcpExposure() itself, above).
   */
  public async toggleMcpWriteAccess(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit it there instead.");
      return;
    }
    if (!this.dbDetails.mcpExposed) {
      logger.showError('Turn on "Toggle MCP Server Exposure" for this connection first — write access needs a connection the MCP server can already see.');
      return;
    }

    const nowEnabled = !this.dbDetails.mcpWriteEnabled;
    const dbName = getDatabaseFileName(this.dbDetails.database);

    if (nowEnabled) {
      const confirm = await window.showWarningMessage(
        `Grant MCP write access to ${dbName}?`,
        {
          modal: true,
          detail: `Any MCP-compatible AI client or agent already connected to the Firebird MCP server will be able to run INSERT/UPDATE/DELETE statements against ${dbName}, not just read its schema/data. There is no per-query confirmation once this is on — the spawned MCP server process has no way to show a VS Code dialog for an individual write. Every write attempt, successful or not, is still logged (see "Show MCP Write Audit Log"). Only grant this for a connection you trust every MCP client configured in this VS Code instance to write to.`,
        },
        "Grant Write Access"
      );
      if (confirm !== "Grant Write Access") {
        return;
      }
    }

    await this.updateSavedConnectionField(context, "mcpWriteEnabled", nowEnabled);
    firebirdTreeDataProvider.refresh();
    notifyMcpExposureChanged();
    logger.showInfo(nowEnabled
      ? `${dbName} now allows MCP write access (INSERT/UPDATE/DELETE via run_write_query).`
      : `${dbName} no longer allows MCP write access.`);
  }

  /** Patches one field of this connection's saved globalState entry (color/group/mcpExposed/mcpWriteEnabled tags — not password, which never lives there). */
  private async updateSavedConnectionField<K extends "color" | "group" | "mcpExposed" | "mcpWriteEnabled">(
    context: ExtensionContext, field: K, value: ConnectionOptions[K]
  ): Promise<void> {
    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
    if (!connections?.[this.dbDetails.id]) { return; }
    connections[this.dbDetails.id][field] = value;
    await context.globalState.update(Constants.ConectionsKey, connections);
    if (Global.activeConnection?.id === this.dbDetails.id) {
      Global.patchActiveConnection({ [field]: value });
    }
  }

  // delete database connection details and remove it from explorer view
  public async removeDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider) {
    logger.info("Remove database start...");

    if (this.dbDetails.workspace) {
      // Sourced from .vscode/firebird.json, not globalState — re-derived from disk on every
      // refresh, so deleting it here would just reappear (and would otherwise still wipe any
      // password already stored for it via setPassword()).
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit or remove it there instead.");
      return;
    }

    await this.removeSavedConnectionEntry(context);
    firebirdTreeDataProvider.refresh();
    logger.info("Remove database end...");
  }

  /** Permanently deletes the database itself (not just its saved connection entry) — no undo. */
  public async dropDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    logger.info("Drop database start...");
    const resolved = await this.resolvedDetails();

    try {
      await Driver.dropDatabase(resolved);
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not drop the database: ${err?.message ?? err}`);
      return;
    }

    // The database no longer exists — its saved connection entry (if any) would just fail to
    // connect from now on, so clean it up the same way removeDatabase() does.
    if (!this.dbDetails.workspace) {
      await this.removeSavedConnectionEntry(context);
    }
    firebirdTreeDataProvider.refresh();
    logger.info("Drop database end...");
    logger.showInfo(`Database ${getDatabaseFileName(this.dbDetails.database)} dropped.`);
  }

  /**
   * Renames an embedded database's file on disk and updates its saved connection entry to match.
   * Scoped to embedded connections only — a network connection's database file lives on the
   * remote server's filesystem, which this extension has no access to rename.
   */
  public async renameDatabase(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (!this.dbDetails.embedded) {
      logger.showInfo("Only embedded database connections can be renamed here — a network database's file lives on the remote server.");
      return;
    }
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit or remove it there instead.");
      return;
    }

    const currentPath = this.dbDetails.database;
    const newUri = await window.showSaveDialog({
      title: "Rename Database To",
      defaultUri: Uri.file(currentPath),
      filters: { "Firebird Database": ["fdb", "gdb"], "All files": ["*"] },
    });
    if (!newUri) {
      return;
    }
    const newPath = newUri.fsPath;
    if (newPath === currentPath) {
      return;
    }

    const answer = await window.showWarningMessage(
      `Rename ${getDatabaseFileName(currentPath)} to ${getDatabaseFileName(newPath)}? The database must not be in use by any connection.`,
      { modal: true },
      "Rename"
    );
    if (answer !== "Rename") {
      return;
    }

    try {
      const { rename } = await import("fs/promises");
      await rename(currentPath, newPath);
    } catch (err: any) {
      logger.error(err?.message ?? err);
      logger.showError(`Could not rename the database file: ${err?.message ?? err}`);
      return;
    }

    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
    if (connections?.[this.dbDetails.id]) {
      connections[this.dbDetails.id].database = newPath;
      await context.globalState.update(Constants.ConectionsKey, connections);
    }
    if (Global.activeConnection?.id === this.dbDetails.id) {
      Global.patchActiveConnection({ database: newPath });
    }

    firebirdTreeDataProvider.refresh();
    logger.showInfo(`Database renamed to ${getDatabaseFileName(newPath)}.`);
  }

  /**
   * "Edit Connection" (docs/roadmap/connection-management-enhancements.md, phase 3) — runs the
   * same wizard used to create a connection, pre-filled from this one, and saves the result back
   * over the existing saved entry (same id) instead of creating a new one. The real password is
   * resolved first so the wizard's password field prefills correctly and an in-wizard "Test
   * Connection" works without the user having to retype an unchanged password.
   */
  public async editConnection(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — edit or remove it there instead.");
      return;
    }

    const resolved = await this.resolvedDetails();
    let updated: ConnectionOptions;
    try {
      updated = await connectionWizard("FIREBIRD: Edit Connection", resolved);
    } catch (err: any) {
      // Cancelled (Escape at any step) -- connectionWizard()'s step chain rejects rather than
      // resolving, same as the create-connection flow; nothing to save.
      if (err) { logger.info(String(err)); }
      return;
    }

    const id = this.dbDetails.id;
    await CredentialStore.storePassword(id, updated.password || "");
    if (updated.sshTunnel) {
      await CredentialStore.storeSshPassword(id, updated.sshTunnelPassword || "");
    } else {
      await CredentialStore.deleteSshPassword(id);
    }

    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
    connections[id] = { ...updated, id, password: undefined, sshTunnelPassword: undefined };
    await context.globalState.update(Constants.ConectionsKey, connections);

    if (Global.activeConnection?.id === id) {
      Global.activeConnection = { ...updated, id };
    }

    firebirdTreeDataProvider.refresh();
    logger.showInfo("Connection updated.");
  }

  /** Deletes this connection's saved entry from globalState (not the database file itself). */
  private async removeSavedConnectionEntry(context: ExtensionContext): Promise<void> {
    const connections = context.globalState.get<{[key: string]: ConnectionOptions;}>(Constants.ConectionsKey);

    if (connections) {
      delete connections[this.dbDetails.id];
      await CredentialStore.deletePassword(this.dbDetails.id);
      await CredentialStore.deleteSshPassword(this.dbDetails.id);
      await context.globalState.update(Constants.ConectionsKey, connections);
      logger.debug(`Removed connection ${this.dbDetails.id}`);
    }
  }

  // set active database
  public async setActive(): Promise<void> {
    logger.info("Set active connection");
    Global.activeConnection = await this.resolvedDetails();
  }

  /**
   * Stores/updates this connection's password in SecretStorage. The only way to set a password
   * for a workspace-declared connection (.vscode/firebird.json never contains one), but works
   * for any saved connection — there was previously no way to change one without removing and
   * re-adding the whole connection.
   */
  public async setPassword(): Promise<void> {
    const password = await window.showInputBox({
      prompt: `New password for ${getDatabaseFileName(this.dbDetails.database)}`,
      ignoreFocusOut: true,
      password: true,
      validateInput: v => v ? undefined : "Password is required"
    });
    if (password === undefined) { return; }
    await CredentialStore.storePassword(this.dbDetails.id, password);
    logger.showInfo("Password updated.");
  }

  /**
   * "Copy Connection String" (docs/roadmap/connection-management-enhancements.md, phase 2).
   * Never includes the password — see buildConnectionString()'s own doc comment for why.
   */
  public async copyConnectionString(): Promise<void> {
    await env.clipboard.writeText(buildConnectionString(this.dbDetails));
    logger.showInfo("Connection string copied to clipboard (password not included).");
  }

  /**
   * Stores/updates this connection's SSH tunnel password (authMethod "password") or private-key
   * passphrase (authMethod "privateKey") in SecretStorage — mirrors setPassword() above exactly,
   * including being the only way to set one for a workspace-declared connection, since
   * .vscode/firebird.json's own "sshTunnel" field can only carry non-secret config
   * (docs/roadmap/ssh-tunneling.md, src/shared/workspace-config.ts#parseWorkspaceSshTunnel()).
   * Also the only way to *change* an SSH tunnel password for any connection post-creation — the
   * connection wizard only ever collects one at creation time.
   */
  public async setSshTunnelPassword(): Promise<void> {
    if (!this.dbDetails.sshTunnel) {
      logger.showError("This connection has no SSH tunnel configured — add one from the Add/Edit Connection wizard (or this workspace's .vscode/firebird.json) first.");
      return;
    }
    const passwordLabel = this.dbDetails.sshTunnel.authMethod === "privateKey" ? "passphrase" : "password";
    const password = await window.showInputBox({
      prompt: `New SSH ${passwordLabel} for ${getDatabaseFileName(this.dbDetails.database)}`,
      ignoreFocusOut: true,
      password: true,
    });
    if (password === undefined) { return; }
    await CredentialStore.storeSshPassword(this.dbDetails.id, password);
    logger.showInfo("SSH tunnel password updated.");
  }

  // open the Live Profiler (polling connection/query activity) for this database
  public async monitorDatabase(profilerView: ProfilerView): Promise<void> {
    logger.info("Monitor Database: open Live Profiler");
    const resolved = await this.resolvedDetails();
    Global.activeConnection = resolved;
    profilerView.open(resolved);
  }

  // backup database using gbak
  public async backupDatabase(taskTracker?: TaskTracker, gbakExecutable: string = "gbak"): Promise<void> {
    const pickedOptions = await window.showQuickPick(BACKUP_OPTION_ITEMS, {
      canPickMany: true,
      placeHolder: "Backup options (leave everything unchecked for Firebird's own defaults)",
    });
    if (pickedOptions === undefined) { return; } // Escape/dismissed -- cancel the whole backup, matching the file picker below.

    const saveUri = await window.showSaveDialog({
      title: "Backup Firebird Database",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      defaultUri: undefined
    });
    if (!saveUri) { return; }

    const backupPath = saveUri.fsPath;
    const { host, port, database, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${database}`;
    const choices: BackupFlagChoices = {};
    for (const item of pickedOptions) { choices[item.key] = true; }
    const args = ["-b", ...buildBackupFlags(choices), "-user", user, "-password", password ?? "", hostPort, backupPath];

    logger.info(`Starting backup to ${backupPath}`);
    logger.output(`[gbak] ${renderGbakCommand(gbakExecutable, args)}`);
    // Background Tasks entry (docs/roadmap/connection-management-enhancements.md, phase 4) --
    // alongside, not instead of, the progress notification below: a durable record for anyone who
    // isn't watching when a backup finishes.
    const task = taskTracker?.start(`Backup: ${getDatabaseFileName(database)} → ${backupPath}`);

    const child = cp.execFile(gbakExecutable, args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));

    // Cancel support (docs/roadmap/backup-restore-options.md, phase 3) -- a cancellable progress
    // notification in place of the old status bar spinner, so a long backup can actually be
    // stopped rather than only having its indicator hidden.
    await window.withProgress(
      { location: ProgressLocation.Notification, title: `Backing up ${getDatabaseFileName(database)}…`, cancellable: true },
      (_progress, token) => new Promise<void>(resolve => {
        let cancelled = false;
        token.onCancellationRequested(() => {
          cancelled = true;
          child.kill();
        });

        child.on("error", err => {
          logger.error(`Backup error: ${err.message}`);
          logger.showError(`Backup failed: ${err.message}`);
          task?.fail(err.message);
          resolve();
        });

        child.on("close", code => {
          if (cancelled) {
            logger.info("Backup cancelled.");
            logger.showInfo("Backup cancelled. The backup file may be incomplete.");
            task?.fail("Cancelled");
          } else if (code === 0) {
            logger.info(`Backup completed: ${backupPath}`);
            window.showInformationMessage(`Database backed up successfully to ${backupPath}`);
            task?.complete();
          } else {
            logger.error(`Backup failed with exit code ${code}`);
            logger.showError(`Backup failed (exit code ${code}). Check the log for details.`);
            task?.fail(`gbak exited with code ${code}`);
          }
          resolve();
        });
      })
    );
  }

  // restore database using gbak
  public async restoreDatabase(taskTracker?: TaskTracker, gbakExecutable: string = "gbak"): Promise<void> {
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

    // Restore options (docs/roadmap/backup-restore-options.md, phase 2). Asked after the file
    // pickers so the two questions everyone must answer come first; dismissing cancels the whole
    // restore, matching the pickers' own behavior and backupDatabase()'s options step.
    const pickedOptions = await window.showQuickPick(RESTORE_OPTION_ITEMS, {
      canPickMany: true,
      placeHolder: "Restore options (leave everything unchecked for Firebird's own defaults)",
    });
    if (pickedOptions === undefined) { return; }

    const pickedKeys = new Set(pickedOptions.map(item => item.key));
    const choices: RestoreFlagChoices = {
      metadataOnly: pickedKeys.has("metadataOnly"),
      oneAtATime: pickedKeys.has("oneAtATime"),
      noValidity: pickedKeys.has("noValidity"),
      noShadows: pickedKeys.has("noShadows"),
    };

    // Only asked when its checkbox was ticked — a page-size prompt on every restore would be a
    // dialog almost nobody needs.
    if (pickedKeys.has("pageSize")) {
      const pickedSize = await window.showQuickPick(
        RESTORE_PAGE_SIZES.map(size => ({ label: String(size), description: size === 8192 ? "Firebird's default" : undefined })),
        { placeHolder: "Page size for the restored database" }
      );
      if (!pickedSize) { return; }
      choices.pageSize = Number(pickedSize.label);
    }

    const { host, port, user, password } = this.dbDetails;
    const hostPort = `${host}/${port ?? 3050}:${restorePath}`;
    const mode: RestoreMode = pickedKeys.has("replace") ? "replace" : "create";
    const args = buildRestoreArgs({ mode, choices, user, password: password ?? "", backupPath, target: hostPort });

    // Command preview before a destructive operation — the same assembled args that will actually
    // run, with the password redacted (renderGbakCommand()). Modal on purpose: replacing a live
    // database shouldn't be a blind "trust the checkboxes I ticked" action.
    const confirmed = await window.showWarningMessage(
      mode === "replace"
        ? `Replace the database at ${restorePath}? Its current contents will be lost.`
        : `Restore to ${restorePath}?`,
      { modal: true, detail: renderGbakCommand(gbakExecutable, args) },
      "Restore"
    );
    if (confirmed !== "Restore") { return; }

    logger.info(`Starting restore from ${backupPath} to ${restorePath}`);
    logger.output(`[gbak] ${renderGbakCommand(gbakExecutable, args)}`);
    const task = taskTracker?.start(`Restore: ${getDatabaseFileName(backupPath)} → ${restorePath}`);

    const child = cp.execFile(gbakExecutable, args);
    child.stderr?.on("data", d => logger.output(`[gbak] ${d}`));

    // Cancel support (phase 3): a cancellable progress notification replaces the old status bar
    // spinner — gbak is a real child process, so cancelling can actually kill it rather than just
    // hiding the indicator. The promise resolves on the process's own close/error either way.
    await window.withProgress(
      { location: ProgressLocation.Notification, title: `Restoring ${getDatabaseFileName(restorePath)}…`, cancellable: true },
      (_progress, token) => new Promise<void>(resolve => {
        let cancelled = false;
        token.onCancellationRequested(() => {
          cancelled = true;
          child.kill();
        });

        child.on("error", err => {
          logger.error(`Restore error: ${err.message}`);
          logger.showError(`Restore failed: ${err.message}`);
          task?.fail(err.message);
          resolve();
        });

        child.on("close", code => {
          if (cancelled) {
            logger.info("Restore cancelled.");
            logger.showInfo("Restore cancelled. The target database may be incomplete.");
            task?.fail("Cancelled");
          } else if (code === 0) {
            logger.info(`Restore completed: ${restorePath}`);
            window.showInformationMessage(`Database restored successfully to ${restorePath}`);
            task?.complete();
          } else {
            logger.error(`Restore failed with exit code ${code}`);
            logger.showError(`Restore failed (exit code ${code}). Check the log for details.`);
            task?.fail(`gbak exited with code ${code}`);
          }
          resolve();
        });
      })
    );
  }
}

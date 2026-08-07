import {ExtensionContext, TreeItem, TreeItemCollapsibleState, window, Uri, ThemeIcon, ThemeColor, env, QuickPickItem, ProgressLocation} from "vscode";
import {join} from "path";
import {NodeTable, NodeCategoryFolder, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain, NodeRole, NodeException, NodeSystemTable, NodeUser, NodeSchema} from "./";
import {ConnectionOptions, FirebirdTree} from "../interfaces";
import {getOptions, Constants} from "../config";
import {Driver} from "../shared/driver";
import {Global} from "../shared/global";
import {CredentialStore} from "../shared/credential-store";
import {FirebirdTreeDataProvider} from "../firebirdTreeDataProvider";
import {getMaxParallelWorkersQuery, databaseInfoQry, getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery, getGeneratorsQuery, getDomainsQuery, getRolesQuery, getExceptionsQuery, getSystemTablesQuery, getUsersQuery, getSchemasQuery} from "../shared/queries";
import {getEngineMajorVersion} from "../shared/engine-version";
import {supportsSchemas} from "../shared/schema-support";
import {logger} from "../logger/logger";
import {getDatabaseFileName} from "../shared/utils";
import {getObjectFilter, matchesObjectFilter} from "../shared/object-explorer-filter";
import {buildConnectionString} from "../shared/connection-string";
import {connectionWizard} from "../shared/connection-wizard";
import {TaskTracker} from "../task-panel/task-tracker";
import {buildBackupFlags, BackupFlagChoices, buildRestoreArgs, renderGbakCommand, RestoreFlagChoices, RestoreMode, RESTORE_PAGE_SIZES, buildParallelFlag, parseMaxParallelWorkers, buildMultiFileTargets, isValidVolumeSize} from "../shared/gbak-options";
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

/** backupDatabase()'s phase-4 extras, kept separate because neither is a plain on/off flag. */
const BACKUP_EXTRA_ITEMS: (QuickPickItem & { key: "split" | "parallel" })[] = [
  { label: "Split into multiple files…", description: "For a backup too large for one file (or one volume)", key: "split" },
  { label: "Use parallel workers…", description: "Faster on a server configured for it", key: "parallel" },
];

/**
 * restoreDatabase()'s options QuickPick (docs/roadmap/backup-restore-options.md, phase 2).
 * "Replace an existing database" is presented as a checkbox here even though it isn't a modifier
 * flag — it switches gbak's top-level `-C`/`-REP` switch — because a separate dialog just to ask
 * "create or replace?" would be a third prompt before every restore for a question most people
 * answer the same way every time.
 */
const RESTORE_OPTION_ITEMS: (QuickPickItem & { key: keyof RestoreFlagChoices | "replace" | "pageSize" | "parallel" })[] = [
  { label: "Replace an existing database", description: "Otherwise the restore fails if the target file already exists", key: "replace" },
  { label: "Metadata only", description: "Schema only, no table data", key: "metadataOnly" },
  { label: "One table at a time", description: "Slower, but can get past a single unreadable table", key: "oneAtATime" },
  { label: "Skip validity conditions", description: "Don't restore NOT NULL/CHECK constraints", key: "noValidity" },
  { label: "Don't recreate shadows", description: "Restore without the database's shadow files", key: "noShadows" },
  { label: "Override page size…", description: "Pick a page size instead of the one recorded in the backup", key: "pageSize" },
  { label: "Use parallel workers…", description: "Faster on a server configured for it", key: "parallel" },
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
      label: getDatabaseFileName(this.dbDetails.database) + (this.dbDetails.isDefault ? " ★" : ""),
      description: unreachable ? "⚠ connection lost" : undefined,
      collapsibleState: TreeItemCollapsibleState.Collapsed,
      contextValue: this.dbDetails.isDefault ? "databaseDefault" : "database",
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

  /**
   * Object categories, or — on a Firebird 6 database with more than one user schema — a level of
   * schemas with those categories beneath each.
   *
   * The extra level appears only when it distinguishes something. Every Firebird 6 database has
   * `PUBLIC`, so showing it unconditionally would add a click for every database that has exactly
   * one schema and always will.
   */
  public async getChildren(): Promise<FirebirdTree[]> {
    const schemas = await this.userSchemas();
    if (schemas.length > 1) {
      return schemas.map(schema => new NodeSchema(schema, (s: string) => this.categoryFolders(s), this.dbDetails));
    }
    return this.categoryFolders();
  }

  /**
   * The category folders, optionally scoped to one schema.
   *
   * Roles and Users are deliberately absent from a schema's folders: both are database-wide
   * (`RDB$ROLES` has no `RDB$SCHEMA_NAME` column — checked against a live server), so listing them
   * under each schema would repeat the same rows and imply an ownership that does not exist.
   */
  private categoryFolders(schema?: string): FirebirdTree[] {
    const children: FirebirdTree[] = [
      new NodeCategoryFolder("Tables", "tables", this.dbDetails, () => this.getTableChildren(schema)),
      new NodeCategoryFolder("Views", "views", this.dbDetails, () => this.getViewChildren(schema)),
      new NodeCategoryFolder("Stored Procedures", "procedures", this.dbDetails, () => this.getProcedureChildren(schema)),
      new NodeCategoryFolder("Triggers", "triggers", this.dbDetails, () => this.getTriggerChildren(schema)),
      new NodeCategoryFolder("Generators", "generators", this.dbDetails, () => this.getGeneratorChildren(schema)),
      new NodeCategoryFolder("Domains", "domains", this.dbDetails, () => this.getDomainChildren(schema)),
    ];
    // Roles between Domains and Exceptions, Users last: the flat layout's folder order is
    // unchanged from before schemas existed, which a suite-tier test asserts exactly.
    if (!schema) {
      children.push(new NodeCategoryFolder("Roles", "roles", this.dbDetails, this.getRoleChildren.bind(this)));
    }
    children.push(new NodeCategoryFolder("Exceptions", "exceptions", this.dbDetails, () => this.getExceptionChildren(schema)));
    if (!schema) {
      children.push(new NodeCategoryFolder("Users", "users", this.dbDetails, this.getUserChildren.bind(this)));
    }
    if (getOptions().showSystemObjects && !schema) {
      children.push(new NodeCategoryFolder("System Tables", "systemTables", this.dbDetails, this.getSystemTableChildren.bind(this)));
    }
    return children;
  }

  /** User schemas on this connection, or [] on a server without them. Empty means "no schema level". */
  private async userSchemas(): Promise<string[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    if (!(await this.schemasSupported(connection, resolved))) {
      return [];
    }
    try {
      const rows = await Driver.client.queryPromise<any>(connection, getSchemasQuery());
      return (rows ?? []).map((r: any) => String(r.SCHEMA_NAME).trim());
    } catch {
      // A failed lookup must not cost the user their tree — fall back to the flat layout.
      return [];
    }
  }

  /**
   * Narrows rows to one schema, when the tree is showing a schema level.
   *
   * Filtered here rather than in SQL: the listing queries already return `SCHEMA_NAME` for every
   * row, so scoping client-side needs no second query shape and keeps one statement per category
   * regardless of how the tree is arranged.
   */
  private inSchema<T extends { SCHEMA_NAME?: unknown }>(rows: T[], schema?: string): T[] {
    if (!schema) { return rows; }
    return rows.filter(r => String(r.SCHEMA_NAME ?? "").trim() === schema);
  }

  /** Narrows rows to those matching this category's active object filter (if any), set via NodeCategoryFolder#setFilter(). */
  private filterRows<T>(rows: T[], category: string, nameOf: (row: T) => string): T[] {
    const filter = getObjectFilter(this.dbDetails.id, category);
    if (!filter) { return rows; }
    return rows.filter(row => matchesObjectFilter(nameOf(row), filter));
  }

  /**
   * Whether this connection's server understands SQL schemas, i.e. Firebird 6+. Cached per
   * connection by `getEngineMajorVersion()`, so the extra round trip happens once rather than on
   * every expand.
   */
  private async schemasSupported(connection: any, resolved: ConnectionOptions): Promise<boolean> {
    return supportsSchemas(
      await getEngineMajorVersion(resolved.id, sql => Driver.client.queryPromise<any>(connection, sql))
    );
  }

  private async getTableChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);

    // Firebird 6 put every object in a schema. Asking a pre-6 server for RDB$SCHEMA_NAME is a hard
    // SQL error, not a degradation, so the column is only requested once the server has said it is
    // new enough — and a version probe that fails reports 0, i.e. legacy behaviour.
    const withSchemas = await this.schemasSupported(connection, resolved);

    const tablesQry = getTablesQuery(getOptions().maxTablesCount, withSchemas);
    const tables = await Driver.client.queryPromise<any>(connection, tablesQry);
    return this.filterRows(this.inSchema(tables, schema), "tables", t => t.TABLE_NAME).map<NodeTable>(
      table => new NodeTable(this.dbDetails, table.TABLE_NAME, withSchemas ? table.SCHEMA_NAME : undefined, schema)
    );
  }

  private async getViewChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const views = await Driver.client.queryPromise<any>(connection, getViewsQuery(withSchemas));
    return this.filterRows(this.inSchema(views, schema), "views", v => v.VIEW_NAME).map<NodeView>(
      view => new NodeView(this.dbDetails, view.VIEW_NAME, withSchemas ? view.SCHEMA_NAME : undefined, schema)
    );
  }

  private async getProcedureChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const procs = await Driver.client.queryPromise<any>(connection, getStoredProceduresQuery(withSchemas));
    return this.filterRows(this.inSchema(procs, schema), "procedures", p => p.PROCEDURE_NAME).map<NodeProcedure>(proc => new NodeProcedure(this.dbDetails, proc.PROCEDURE_NAME, withSchemas ? proc.SCHEMA_NAME : undefined, schema));
  }

  private async getTriggerChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const triggers = await Driver.client.queryPromise<any>(connection, getTriggersQuery(withSchemas));
    return this.filterRows(this.inSchema(triggers, schema), "triggers", t => t.TRIGGER_NAME).map<NodeTrigger>(trigger => new NodeTrigger(trigger, this.dbDetails, schema));
  }

  private async getGeneratorChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const generators = await Driver.client.queryPromise<any>(connection, getGeneratorsQuery(withSchemas));
    return this.filterRows(this.inSchema(generators, schema), "generators", g => g.GENERATOR_NAME).map<NodeGenerator>(gen => new NodeGenerator(gen.GENERATOR_NAME, this.dbDetails, withSchemas ? gen.SCHEMA_NAME : undefined, schema));
  }

  private async getDomainChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const domains = await Driver.client.queryPromise<any>(connection, getDomainsQuery(withSchemas));
    return this.filterRows(this.inSchema(domains, schema), "domains", d => d.DOMAIN_NAME).map<NodeDomain>(domain => new NodeDomain(domain, this.dbDetails, schema));
  }

  private async getRoleChildren(): Promise<FirebirdTree[]> {
    const connection = await Driver.client.createConnection(await this.resolvedDetails());
    const roles = await Driver.client.queryPromise<any>(connection, getRolesQuery());
    return this.filterRows(roles, "roles", r => r.ROLE_NAME).map<NodeRole>(role => new NodeRole(role.ROLE_NAME, this.dbDetails));
  }

  private async getExceptionChildren(schema?: string): Promise<FirebirdTree[]> {
    const resolved = await this.resolvedDetails();
    const connection = await Driver.client.createConnection(resolved);
    const withSchemas = await this.schemasSupported(connection, resolved);
    const exceptions = await Driver.client.queryPromise<any>(connection, getExceptionsQuery(withSchemas));
    return this.filterRows(this.inSchema(exceptions, schema), "exceptions", e => e.EXCEPTION_NAME).map<NodeException>(exception => new NodeException(exception, this.dbDetails, schema));
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
  private async updateSavedConnectionField<K extends "color" | "group" | "mcpExposed" | "mcpWriteEnabled" | "defaultSchema">(
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

  public async setDefaultConnection(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — set it as default there instead.");
      return;
    }

    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
    const id = this.dbDetails.id;
    if (!connections[id]) { return; }

    for (const key of Object.keys(connections)) {
      connections[key].isDefault = (key === id);
    }

    await context.globalState.update(Constants.ConectionsKey, connections);
    firebirdTreeDataProvider.savedConnections = connections;
    firebirdTreeDataProvider.refresh();
    logger.showInfo(`Connection '${getDatabaseFileName(this.dbDetails.database)}' set as default connection.`);
  }

  public async clearDefaultConnection(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      return;
    }

    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
    const id = this.dbDetails.id;
    if (!connections[id]) { return; }

    connections[id].isDefault = false;

    await context.globalState.update(Constants.ConectionsKey, connections);
    firebirdTreeDataProvider.savedConnections = connections;
    firebirdTreeDataProvider.refresh();
    logger.showInfo(`Connection '${getDatabaseFileName(this.dbDetails.database)}' cleared from default connection.`);
  }

  /**
   * Sets the schema unqualified names resolve through on this connection, for the whole session
   * rather than per document (docs/roadmap/firebird6-schemas.md, phase 3).
   *
   * Distinct from **New Query in Schema…**, which puts a `SET SEARCH_PATH` at the top of one
   * document: this applies before the first statement of every session, so the tree, completion
   * and every command see the same resolution the editor does.
   */
  public async setDefaultSchema(context: ExtensionContext, firebirdTreeDataProvider: FirebirdTreeDataProvider): Promise<void> {
    if (this.dbDetails.workspace) {
      logger.showInfo("This connection comes from this workspace's .vscode/firebird.json — set \"defaultSchema\" there instead.");
      return;
    }

    const resolved = await this.resolvedDetails();
    const major = await getEngineMajorVersion(resolved.id, sql => Driver.runQuery(sql, resolved));
    if (!supportsSchemas(major)) {
      logger.showInfo(
        major > 0
          ? `SQL schemas need Firebird 6 or later; this server reports version ${major}.`
          : "SQL schemas need Firebird 6 or later, and this server's version could not be read."
      );
      return;
    }

    const schemas = await this.userSchemas();
    const current = this.dbDetails.defaultSchema?.trim();
    // "Use the server default" is an explicit item rather than an empty input: clearing a setting
    // by deleting text is a guess, and the server default (PUBLIC, SYSTEM) is a real choice.
    const items: QuickPickItem[] = [
      {
        label: "$(discard) Use the server default",
        description: current ? "clears the current setting" : "current",
      },
      ...schemas.map(schema => ({
        label: schema,
        description: schema === current ? "current" : undefined,
      })),
    ];
    const picked = await window.showQuickPick(items, {
      title: `Default schema for ${getDatabaseFileName(this.dbDetails.database)}`,
      placeHolder: "Unqualified names in this connection resolve through this schema first",
    });
    if (!picked) {
      return;
    }

    const chosen = picked.label.startsWith("$(discard)") ? undefined : picked.label;
    await this.updateSavedConnectionField(context, "defaultSchema", chosen);
    // The schema is applied when a session opens, so connections already open — including idle
    // pooled ones — still carry the old search path. Saying so is better than a silent partial
    // effect; PooledClient keys its buckets by schema, so new sessions are correct immediately.
    firebirdTreeDataProvider.refresh();
    logger.showInfo(
      chosen
        ? `Unqualified names on ${getDatabaseFileName(this.dbDetails.database)} will resolve through ${chosen} first, from the next connection onwards.`
        : `${getDatabaseFileName(this.dbDetails.database)} will use the server's default search path from the next connection onwards.`
    );
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

  /**
   * The server's `MaxParallelWorkers` (docs/roadmap/backup-restore-options.md, phase 4). Any failure
   * — an older server with no `RDB$CONFIG`, an unreachable connection — resolves to 1, i.e. "no
   * parallelism offered", so a diagnostic query can never block a backup.
   */
  private async maxParallelWorkers(): Promise<number> {
    try {
      const resolved = await this.resolvedDetails();
      const rows = await Driver.runQuery(getMaxParallelWorkersQuery(), resolved);
      return parseMaxParallelWorkers(rows);
    } catch (err: any) {
      logger.debug(`Could not read MaxParallelWorkers, assuming 1: ${err?.message ?? err}`);
      return 1;
    }
  }

  // backup database using gbak
  public async backupDatabase(taskTracker?: TaskTracker, gbakExecutable: string = "gbak"): Promise<void> {
    // Phase 4's two extras join the phase-1 flag list in one picker, so a backup still asks a single
    // options question; each only prompts further when actually chosen.
    const pickedOptions = await window.showQuickPick([...BACKUP_OPTION_ITEMS, ...BACKUP_EXTRA_ITEMS], {
      canPickMany: true,
      placeHolder: "Backup options (leave everything unchecked for Firebird's own defaults)",
    });
    if (pickedOptions === undefined) { return; } // Escape/dismissed -- cancel the whole backup, matching the file picker below.

    const pickedBackupKeys = new Set(pickedOptions.map(item => item.key));

    // Only offered when the server can actually honor it: asking gbak for more workers than
    // MaxParallelWorkers prints "Wrong parallel workers value N, valid range are from 1 to 1" and
    // silently runs single-threaded (confirmed live), so an unusable picker would be worse than none.
    let parallelWorkers: number | undefined;
    if (pickedBackupKeys.has("parallel")) {
      const maxWorkers = await this.maxParallelWorkers();
      if (maxWorkers <= 1) {
        logger.showInfo("This server is configured with MaxParallelWorkers = 1, so a parallel backup isn't available.");
      } else {
        const pickedWorkers = await window.showQuickPick(
          Array.from({ length: maxWorkers - 1 }, (_unused, i) => String(i + 2)),
          { placeHolder: `Parallel workers (this server allows up to ${maxWorkers})` }
        );
        if (!pickedWorkers) { return; }
        parallelWorkers = Number(pickedWorkers);
      }
    }

    let volumeCount = 1;
    let volumeSize = "";
    if (pickedBackupKeys.has("split")) {
      const countInput = await window.showInputBox({
        title: "Split backup into multiple files",
        prompt: "How many files? (gbak needs every volume named up front)",
        value: "2",
        validateInput: value => (/^\d+$/.test(value.trim()) && Number(value) >= 2 ? undefined : "Enter a whole number of 2 or more."),
      });
      if (!countInput) { return; }
      const sizeInput = await window.showInputBox({
        title: "Split backup into multiple files",
        prompt: "Size of each file except the last (e.g. 500m, 2g, or a bare page count)",
        value: "500m",
        validateInput: value => (isValidVolumeSize(value) ? undefined : "Use a number optionally followed by k, m, or g."),
      });
      if (!sizeInput) { return; }
      volumeCount = Number(countInput.trim());
      volumeSize = sizeInput.trim();
    }

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
    for (const item of pickedOptions) {
      if (item.key !== "split" && item.key !== "parallel") { choices[item.key] = true; }
    }
    // The volume list goes last: gbak reads `… <source> file1 <size> file2 …`, and a single volume
    // collapses back to exactly the one-file argument this command produced before phase 4.
    const args = [
      "-b",
      ...buildBackupFlags(choices),
      ...buildParallelFlag(parallelWorkers),
      "-user", user, "-password", password ?? "",
      hostPort,
      ...buildMultiFileTargets(backupPath, volumeCount, volumeSize),
    ];

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
    // canSelectMany, because phase 4 can *produce* a multi-file backup and gbak needs every volume
    // listed in order to restore one. Selection order isn't guaranteed by the dialog, so volumes are
    // sorted naturally (backup.fbk, backup.2.fbk, … backup.10.fbk) rather than lexically, which
    // would put .10 before .2.
    const openUris = await window.showOpenDialog({
      title: "Select Firebird Backup File(s)",
      filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
      canSelectMany: true
    });
    if (!openUris || openUris.length === 0) { return; }

    const backupPaths = openUris
      .map(uri => uri.fsPath)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const backupPath = backupPaths[0];

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

    let restoreWorkers: number | undefined;
    if (pickedKeys.has("parallel")) {
      const maxWorkers = await this.maxParallelWorkers();
      if (maxWorkers <= 1) {
        logger.showInfo("This server is configured with MaxParallelWorkers = 1, so a parallel restore isn't available.");
      } else {
        const pickedWorkers = await window.showQuickPick(
          Array.from({ length: maxWorkers - 1 }, (_unused, i) => String(i + 2)),
          { placeHolder: `Parallel workers (this server allows up to ${maxWorkers})` }
        );
        if (!pickedWorkers) { return; }
        restoreWorkers = Number(pickedWorkers);
      }
    }

    const args = buildRestoreArgs({ mode, choices, user, password: password ?? "", backupPaths, target: hostPort, parallelWorkers: restoreWorkers });

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

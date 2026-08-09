import {ExtensionContext, window, commands, workspace, QuickPickItem} from "vscode";
import {Constants, getOptions} from "./config";
import {FirebirdTreeDataProvider} from "./firebirdTreeDataProvider";
import {NodeHost, NodeDatabase, NodeTable, NodeField, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain, NodeRole, NodeException, NodeUser, NodeIndex, NodeIndexFolder, NodeCategoryFolder} from "./nodes";
import {Options, FirebirdTree, ConnectionOptions} from "./interfaces";
import {connectionPicker, pickConnectionOptions} from "./shared/connection-picker";
import {getEngineMajorVersion} from "./shared/engine-version";
import {supportsSchemas} from "./shared/schema-support";
import {createSchemaQuery, dropSchemaQuery, getSchemasQuery, setSearchPathQuery, alterSchemaQuery} from "./shared/queries";
import {Driver, BatchResult, activeEditorSql} from "./shared/driver";
import {ExecutionDiagnostics} from "./shared/execution-diagnostics";
import {shiftPosition} from "./shared/statement-position";
import * as vscode from 'vscode';
import {Global} from "./shared/global";
import {CredentialStore} from "./shared/credential-store";
import {logger} from "./logger/logger";
import {KeywordsDb} from "./language-server/db-words.provider";
import QueryResultsView, {AnalyzeResultsRequest, AnalyzePlanRequest, ViewTableDiagramRequest, RevealStatementRequest} from "./result-view";
import {SchemaDesigner} from "./schema-designer";
import {QueryPlanView} from "./query-plan-view";
import {ProfilerView} from "./profiler";
import MockData from "./mock-data/mock-data";
import LanguageServer from "./language-server";
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {extractChangelogEntry, summarizeChangelogEntry} from "./shared/changelog-notice";
import {extractNamedParameters, rewriteNamedParametersToPositional, coerceParamValue, ParamType} from "./shared/parameterized-query";
import {formatSQL} from "./shared/sql-formatter";
import {splitStatementsWithOffsets} from "./shared/sql-splitter";
import {probeGbak, probeIsql} from "./shared/executable-probe";
import {
  applySelectedText,
  findBookmarkForSlot,
  QUICK_QUERY_SLOT_COUNT,
  QuickQuery,
  resolveQuickQuery,
} from "./shared/quick-queries";
import {SqlLinter} from "./shared/sql-linter";
import {BookmarkProvider, BookmarkItem} from "./bookmarks/bookmark-provider";
import {fetchSchemaSnapshot, diffSchemas, renderDiffReport, renderDiffMarkdown} from "./schema-diff/schema-diff";
import {renderKnexMigration, knexMigrationTimestamp} from "./schema-diff/knex-migration";
import {QueryHistoryProvider, QueryHistoryItem} from "./query-history/query-history-provider";
import {TaskTracker} from "./task-panel/task-tracker";
import {registerCopilotChatParticipant} from "./copilot/copilot-chat-participant";
import {registerAiQueryActions, runAnalyzeResultsAction, runAnalyzePlanAction} from "./copilot/ai-query-actions";
import {buildIsqlArgs, buildIsqlCommandLine, buildIsqlEnv, isqlRunFailed, resolveIsqlExecutable, summarizeIsqlFailure} from "./shared/isql-terminal";
import {resolveGbakExecutable} from "./shared/gbak-options";
import {attemptConnection} from "./shared/connection-wizard";
import {getConnectionLabel} from "./shared/utils";
import {loadWorkspaceConnections} from "./shared/workspace-config";
import {registerSqlNotebook, FIREBIRD_NOTEBOOK_TYPE} from "./sql-notebook";
import {registerMcpServer, openMcpWriteAuditLog} from "./mcp-server";
import {registerLanguageModelTools} from "./copilot/lm-tools";
import {listConnections, getActiveConnection} from "./connection-sharing";
import {runQuery, runWriteQuery} from "./connection-sharing/run-query";
import {editConnectionSharingPermissions} from "./connection-sharing/permissions";
import {runBuildProject, runPublishProject, runGenerateMigrationScript} from "./database-projects";
import {runContainerProvisionWizard} from "./container-provisioning";
import {runObjectSearch} from "./object-search";

/**
 * Inline input-box validation for names the user is *creating* (a new index, a new column, ...).
 *
 * Deliberately stricter than `shared/row-edit.ts`'s `assertValidIdentifier()`, which also accepts a
 * two-part `SCHEMA.OBJECT` name so Firebird 6 tables outside the default schema can be addressed:
 * an object being created belongs to one schema and is named with one identifier, so a dot here is
 * a mistake rather than a qualification.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function poolingOptions(config: Options): { maxSize: number; idleTimeoutMs: number } | undefined {
  return config.enableConnectionPooling
    ? { maxSize: config.connectionPoolMaxSize, idleTimeoutMs: config.connectionPoolIdleTimeoutMs }
    : undefined;
}

/**
 * Shows a one-time "What's New" notification after an extension update, summarizing that
 * version's CHANGELOG.md entry. Silent on first-ever install (no stored previous version) since
 * the Getting Started walkthrough already covers first-run onboarding; silent on same-version
 * re-activations (e.g. a window reload) since context.globalState persists across those.
 */
async function showWhatsNewIfUpdated(context: ExtensionContext): Promise<void> {
  const previousVersion = context.globalState.get<string>(Constants.LastShownVersionKey);
  const currentVersion = Constants.Version;
  if (previousVersion === currentVersion) { return; }
  await context.globalState.update(Constants.LastShownVersionKey, currentVersion);
  if (previousVersion === undefined) { return; }

  try {
    const changelogPath = path.join(context.extensionPath, "CHANGELOG.md");
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const entry = extractChangelogEntry(changelog, currentVersion);
    const summary = entry ? summarizeChangelogEntry(entry) : undefined;
    const message = summary
      ? `Firebird Studio updated to v${currentVersion}: ${summary}`
      : `Firebird Studio updated to v${currentVersion}.`;

    const selected = await window.showInformationMessage(message, "Show Full Changelog", "Dismiss");
    if (selected === "Show Full Changelog") {
      try {
        await commands.executeCommand("markdown.showPreview", vscode.Uri.file(changelogPath));
      } catch {
        // markdown-language-features isn't guaranteed to be present/enabled — fall back to plain text.
        await window.showTextDocument(vscode.Uri.file(changelogPath));
      }
    }
  } catch (err) {
    logger.error(err);
  }
}

/** The document a batch was run from, and where in it the executed text began. */
interface BatchOrigin {
  document: vscode.TextDocument;
  sql: string;
  baseOffset: number;
}

/**
 * Re-counts each statement's reported line and column from the start of the *document* rather than
 * from the start of the text that was executed.
 *
 * They are the same thing only when the whole file was run. Run a selection starting on line 40,
 * or one statement out of sixty, and the driver's line 1 is the document's line 40 — reporting it
 * as line 1 would be worse than reporting nothing, because it looks like an answer.
 *
 * `range` and `errorOffset` are deliberately left alone: they are offsets into the executed text,
 * and the one consumer that wants document offsets (execution diagnostics) adds `baseOffset`
 * itself. Shifting them here too would double-count for that caller.
 */
function locateInDocument(results: BatchResult[], origin: BatchOrigin): BatchResult[] {
  if (origin.baseOffset === 0) {
    return results;
  }
  const at = origin.document.positionAt(origin.baseOffset);
  const base = { line: at.line + 1, column: at.character + 1 };
  return results.map(result => ({
    ...result,
    position: result.position && shiftPosition(base, result.position),
    errorPosition: result.errorPosition && shiftPosition(base, result.errorPosition),
  }));
}

/** Prompts for a new object name, validated as a safe Firebird identifier. */
async function promptIdentifier(prompt: string, placeHolder: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: v => IDENTIFIER_RE.test(v) ? undefined : "Enter a valid identifier (letters, digits, _, $ — must not start with a digit)"
  });
}

export function activate(context: ExtensionContext) {
  logger.info(`Activating extension ...`);

  /* initialise credential store with extension context for SecretStorage access */
  CredentialStore.setContext(context);
  Global.context = context;

  /**
   * Drop stored passwords whose connection no longer exists.
   *
   * Secrets are written per connection id and removed only when the delete path runs, so a
   * connection removed while that failed leaves a password in SecretStorage forever. Reconciling
   * once at activation keeps the store honest without the user ever having to think about it.
   * Deliberately not awaited: it is housekeeping, and activation should not wait on it.
   */
  void CredentialStore.deleteOrphans(
    Object.keys(context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {})
  ).catch(err => logger.debug(`Could not reconcile stored passwords: ${err}`));

  /* "What's New" notification, shown once after an update (not on first install — the Getting
     Started walkthrough already covers that). */
  void showWhatsNewIfUpdated(context);

  /* load configuration and reload every time it's changed */
  logger.info(`Loading configuration...`);
  let config: Options = getOptions();
  Driver.clientReady = Driver.setClient(config.useNativeDriver, context, poolingOptions(config));
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(() => {
      logger.debug("Configuration changed. Reloading configuration...");
      config = getOptions();
      Driver.clientReady = Driver.setClient(config.useNativeDriver, context, poolingOptions(config));
      commands.executeCommand("firebird.explorer.refresh");
    })
  );

  /* initialize providers */
  const firebirdLanguageServer = new LanguageServer();
  const firebirdDatabaseWords = new KeywordsDb();
  const firebirdTreeDataProvider = new FirebirdTreeDataProvider(context);

  /* Workspace-level or global-level connections: auto-activate the default one
     and keep the tree in sync whenever the file is created/edited/removed. */
  void activateDefaultConnection();
  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(() => {
      commands.executeCommand("firebird.explorer.refresh");
      void activateDefaultConnection();
    })
  );
  const firebirdJsonWatcher = workspace.createFileSystemWatcher("**/.vscode/firebird.json");
  context.subscriptions.push(firebirdJsonWatcher);
  context.subscriptions.push(
    firebirdJsonWatcher.onDidChange(() => commands.executeCommand("firebird.explorer.refresh")),
    firebirdJsonWatcher.onDidCreate(() => commands.executeCommand("firebird.explorer.refresh")),
    firebirdJsonWatcher.onDidDelete(() => commands.executeCommand("firebird.explorer.refresh"))
  );

  /* Per-editor connection binding (firebird.newEditorConnectionBehavior):
     When the user switches focus to a different .sql / .fbnb editor tab,
     refresh the status bar so it shows that tab's own bound connection (or
     the global fallback if the tab has never had one set).
     When a document is closed, drop its per-editor connection slot so memory
     doesn't grow unbounded across a long session. */
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(() => {
      Global.refreshStatusBarForActiveEditor();

      // newEditorConnectionBehavior: when opening a new sql file, apply the
      // configured connection strategy if the editor has no binding yet.
      const activeEditor = window.activeTextEditor;
      if (!activeEditor) { return; }
      const uri = activeEditor.document.uri.toString();
      const lang = activeEditor.document.languageId;
      if (lang !== "sql" && lang !== "firebird") { return; }
      if (Global.hasEditorConnection(uri)) { return; }

      const behavior = workspace.getConfiguration("firebird").get<string>("newEditorConnectionBehavior", "transferActive");
      if (behavior === "none") {
        Global.setEditorConnection(uri, null); // explicitly no connection
      } else if (behavior === "defaultConnection") {
        const defaultId = workspace.getConfiguration("firebird").get<string>("defaultConnectionId", "");
        if (defaultId) {
          Global.getConnectionById(defaultId).then(conn => {
            if (conn) { Global.setEditorConnection(uri, conn); Global.refreshStatusBarForActiveEditor(); }
          }).catch(() => { /* ignore */ });
        }
      } else {
        // "transferActive": inherit whatever the global active connection is (no explicit binding
        // needed — activeConnection getter falls through to _globalActiveConnection already).
      }
    }),
    workspace.onDidCloseTextDocument(doc => {
      Global.removeEditorConnection(doc.uri.toString());
    })
  );

  /* Workspace connections are withheld in an untrusted folder (see loadWorkspaceConnections()).
     Granting trust does not reload the window, so without this the tree would keep showing the
     folder's connections as absent until the user restarted — looking like the file was broken
     rather than withheld. */
  context.subscriptions.push(
    workspace.onDidGrantWorkspaceTrust(() => {
      void activateDefaultConnection();
      void commands.executeCommand("firebird.explorer.refresh");
    })
  );

  async function activateDefaultConnection(): Promise<void> {
    if (Global.activeConnection) { return; }
    // 1. Try workspace default connection first
    const conns = await loadWorkspaceConnections();
    let chosen = conns.find(c => c.isDefault) ?? (conns.length === 1 ? conns[0] : undefined);

    // 2. Fall back to global saved default connection
    if (!chosen) {
      const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
      const savedList = Object.keys(saved).map(id => ({ ...saved[id], id }));
      chosen = savedList.find(c => c.isDefault);
    }

    if (!chosen || Global.activeConnection) { return; }
    const password = await CredentialStore.getPassword(chosen.id);
    Global.activeConnection = { ...chosen, password: password ?? "" };
  }
  const firebirdMockData = new MockData(context.extensionPath);
  const firebirdQueryResults = new QueryResultsView(context.extensionPath);
  const firebirdSchemaDesigner = new SchemaDesigner(context.extensionPath);
  const firebirdQueryPlanView = new QueryPlanView(context.extensionPath);
  const firebirdProfilerView = new ProfilerView(context.extensionPath);

  /* SQL linter */
  const sqlLinter = new SqlLinter();
  sqlLinter.setSchemaProvider(() => firebirdDatabaseWords.getSchema());
  sqlLinter.activate(context);

  /* Execution errors as editor diagnostics — a separate collection from the linter's, which
     rewrites its own wholesale on every keystroke. See src/shared/execution-diagnostics.ts. */
  const executionDiagnostics = new ExecutionDiagnostics();
  executionDiagnostics.activate(context);

  /* Background Tasks — discoverability panel for long-running operations (container
     provisioning, backup/restore) alongside their existing withProgress/status-bar notifications */
  const taskTracker = new TaskTracker();

  /* Bookmarks */
  const bookmarkProvider = new BookmarkProvider(context);

  /* Query history — automatically logs every query executed through Driver
     (predefined queries, drops, table designer DDL, batch runs), not just
     the main "Run Query" flow */
  const queryHistoryProvider = new QueryHistoryProvider(context);
  Driver.setHistoryLogger(entry => {
    queryHistoryProvider.add(entry).catch(err => logger.error(err));
  });

  /* Copilot Chat participant (@firebird) – only when the Chat API is available */
  if (typeof vscode.chat !== 'undefined') {
    registerCopilotChatParticipant(context, firebirdDatabaseWords);
  }

  /* AI Query Actions in the editor (right-click SQL -> Explain/Optimize, no chat panel needed) */
  registerAiQueryActions(context, firebirdDatabaseWords);

  /* AI analysis of query results — the results panel's own "🤖 Analyze" button, wired through
     ResultView's EventEmitter base rather than a direct src/copilot import in result-view/. */
  firebirdQueryResults.on("analyzeResults", (data: AnalyzeResultsRequest) => {
    runAnalyzeResultsAction(data, firebirdDatabaseWords).catch((err: any) => logger.error(err?.message ?? err));
  });

  /* Query Plan Visualizer — Copilot "Analyze" action (phase 6), reachable from both the
     standalone panel and the result-view "Query Plan" tab; same delegation pattern as above. */
  const analyzePlanHandler = (data: AnalyzePlanRequest) => {
    runAnalyzePlanAction(data, firebirdDatabaseWords).catch((err: any) => logger.error(err?.message ?? err));
  };
  firebirdQueryPlanView.on("analyzePlan", analyzePlanHandler);
  firebirdQueryResults.on("analyzePlan", analyzePlanHandler);

  /* Query results "🗺 View Table Diagram" button (docs/roadmap/query-results-enhancements.md,
     phase 5) — same delegation pattern as above; opens the shared Schema Designer instance,
     pre-focused on the table currently entered for row editing. Uses Global.activeConnection,
     the same source row editing's own applyChanges() already implicitly resolves its connection
     from (via Driver.runQuery() with no explicit connectionOptions). */
  firebirdQueryResults.on("viewTableDiagram", (data: ViewTableDiagramRequest) => {
    if (!Global.activeConnection) {
      logger.showError("No Firebird database selected!", ["Cancel", "Set Active Database"]).then(selected => {
        if (selected === "Set Active Database") {
          commands.executeCommand("firebird.chooseActive");
        }
      });
      return;
    }
    firebirdSchemaDesigner.openForAlterTable(Global.activeConnection, data.tableName);
  });

  /* SQL Notebooks (.fbnb) — serializer + execution controller */
  context.subscriptions.push(...registerSqlNotebook(context));

  /* MCP Server (Phase 2: list_connections + get_schema, read-only) — no-ops on VS Code builds without MCP support */
  context.subscriptions.push(registerMcpServer(context));

  /* Language Model Tools (docs/roadmap/language-model-tools.md) — the same five operations the MCP
     server exposes, reachable from Copilot agent mode directly, with no MCP client involved. */
  context.subscriptions.push(...registerLanguageModelTools(context));
  context.subscriptions.push(
    commands.registerCommand("firebird.mcp.showWriteAuditLog", () => {
      openMcpWriteAuditLog(context).catch(err => logger.error(err?.message ?? err));
    })
  );

  /* Cross-Extension Connection Sharing API (docs/roadmap/cross-extension-connection-api.md),
     phase 1: read-only discovery commands for other VS Code extensions. Deliberately not declared
     in package.json's contributes.commands -- these are an API surface for other extensions to
     call programmatically via commands.executeCommand(), not end-user Command Palette entries. */
  context.subscriptions.push(
    commands.registerCommand("firebird.connectionSharing.listConnections", (requestingExtensionId?: string) =>
      listConnections(context, requestingExtensionId)
    )
  );
  context.subscriptions.push(
    commands.registerCommand("firebird.connectionSharing.getActiveConnection", (requestingExtensionId?: string) =>
      getActiveConnection(requestingExtensionId)
    )
  );

  /* Cross-Extension Connection Sharing API, phase 3 -- runQuery, gated by
     requestConnectionSharingPermission()'s cached per-extension grant. Also not declared in
     contributes.commands, same reasoning as phase 1's two commands above. */
  context.subscriptions.push(
    commands.registerCommand(
      "firebird.connectionSharing.runQuery",
      (requestingExtensionId: string, connectionId: string, sql: string) =>
        runQuery(context, requestingExtensionId, connectionId, sql)
    )
  );

  /* Cross-Extension Connection Sharing API, phase 4 -- the opt-in write variant, gated by both
     the base read grant above and a separate, manually-toggled write grant (never auto-prompted
     on first write attempt, unlike the read grant -- see toggleWriteAccess()'s own doc comment).
     Also not declared in contributes.commands. */
  context.subscriptions.push(
    commands.registerCommand(
      "firebird.connectionSharing.runWriteQuery",
      (requestingExtensionId: string, connectionId: string, sql: string) =>
        runWriteQuery(context, requestingExtensionId, connectionId, sql)
    )
  );

  /* "Review Connection Sharing Permissions" -- the one user-facing command in this feature,
     letting the user see/revoke a read grant or toggle write access for an extension that's
     already requested access. Unlike the four commands above, this one *is* meant for the
     Command Palette. */
  context.subscriptions.push(
    commands.registerCommand("firebird.connectionSharing.editPermissions", () => {
      editConnectionSharingPermissions(context).catch(err => logger.error(err?.message ?? err));
    })
  );

  context.subscriptions.push(
    commands.registerCommand("firebird.notebook.new", async () => {
      const notebookData = new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "sql"),
      ]);
      const notebookDocument = await workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, notebookData);
      await window.showNotebookDocument(notebookDocument);
    })
  );

  context.subscriptions.push(
    // createTreeView() (not the plain registerTreeDataProvider() every other view below still
    // uses) -- dragAndDropController is only configurable through this API (docs/roadmap/
    // drag-identifier-into-editor.md).
    window.createTreeView(Constants.FirebirdExplorerViewId, {
      treeDataProvider: firebirdTreeDataProvider,
      dragAndDropController: firebirdTreeDataProvider,
    }),
    /* The bottom-Panel host for query results (firebird.queryResultsLocation). Registered
       unconditionally — VS Code needs a provider for a contributed view whether or not the view is
       currently shown, and the view's own `when` clause is what keeps it out of the way. */
    window.registerWebviewViewProvider("firebird.queryResultsPanel", firebirdQueryResults),
    window.registerTreeDataProvider("firebird-bookmarks", bookmarkProvider),
    window.registerTreeDataProvider("firebird-query-history", queryHistoryProvider),
    window.registerTreeDataProvider("firebird-tasks", taskTracker),
    taskTracker,
    firebirdMockData,
    firebirdQueryResults,
    firebirdSchemaDesigner,
    firebirdQueryPlanView,
    firebirdProfilerView,
    firebirdLanguageServer,
    sqlLinter,
    executionDiagnostics,
    bookmarkProvider,
    queryHistoryProvider
  );

  firebirdLanguageServer.setSchemaHandler(_doc => {
    return firebirdDatabaseWords.getSchema();
  });

  // firebirdMockData.display([], "10");

  /* GENERATE MOCK DATA */
  context.subscriptions.push(
    commands.registerCommand("firebird.mockData", (tableNode: NodeTable) => {
      tableNode.generateMockData(firebirdMockData, config);
    })
  );

  /* EXPLORER TOOLBAR: add new host/database connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.explorer.addConnection", () => {
      firebirdTreeDataProvider.addConnection().catch(err => {
        logger.error(err);
      });
    })
  );

  /* EXPLORER TOOLBAR: create a brand-new database file, then add it as a connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.explorer.createDatabase", () => {
      firebirdTreeDataProvider.createDatabase().catch(err => {
        logger.error(err);
      });
    })
  );

  /* EXPLORER TOOLBAR: provision a brand-new local Firebird server in Docker, then add it as a connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.explorer.createContainer", () => {
      runContainerProvisionWizard(firebirdTreeDataProvider, taskTracker).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Create Firebird Container failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* EXPLORER TOOLBAR: create new sql document */
  context.subscriptions.push(
    commands.registerCommand("firebird.explorer.newSqlDocument", () => {
      Driver.createSQLTextDocument()
        .then(_res => {
          logger.info("New SQL document created...");
        })
        .catch(err => {
          logger.error(err);
        });
    })
  );

  /* EXPLORER TOOLBAR: refresh explorer view items */
  context.subscriptions.push(
    commands.registerCommand("firebird.explorer.refresh", (node: FirebirdTree) => {
      firebirdTreeDataProvider.refresh(node);
    })
  );

  /* HOST ITEM: remove host and it's associated databases */
  context.subscriptions.push(
    commands.registerCommand("firebird.removeHost", (connectionNode: NodeHost) => {
      connectionNode.removeHost(context, firebirdTreeDataProvider);
    })
  );

  /* DB ITEM: set active database */
  context.subscriptions.push(
    commands.registerCommand("firebird.setActive", (databaseNode: NodeDatabase) => {
      databaseNode.setActive();
    }),
    commands.registerCommand("firebird.setDefaultConnection", (databaseNode: NodeDatabase) => {
      databaseNode.setDefaultConnection(context, firebirdTreeDataProvider).catch(err => logger.error(err));
    }),
    commands.registerCommand("firebird.clearDefaultConnection", (databaseNode: NodeDatabase) => {
      databaseNode.clearDefaultConnection(context, firebirdTreeDataProvider).catch(err => logger.error(err));
    })
  );

  /**
   * Firebird 6 schema lifecycle.
   *
   * These live on the database node and the Command Palette rather than on a Schemas tree node,
   * because there is no Schemas level yet (see docs/roadmap/firebird6-schemas.md). Both check the
   * server version first: `RDB$SCHEMAS` and `CREATE SCHEMA` do not exist before Firebird 6, and a
   * raw SQL error would not tell the user why.
   */
  const requireSchemaSupport = async (node: NodeDatabase): Promise<ConnectionOptions | undefined> => {
    const details = await node.getResolvedConnectionDetails();
    const major = await getEngineMajorVersion(details.id, async (sql: string) => {
      const [row] = await Driver.runBatch(sql, details);
      return (row?.rows ?? []) as any[];
    });
    if (!supportsSchemas(major)) {
      logger.showError(
        `SQL schemas need Firebird 6 or newer; this server reports ${major || "an unknown version"}.`
      );
      return undefined;
    }
    return details;
  };

  context.subscriptions.push(
    commands.registerCommand("firebird.database.createSchema", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      const details = await requireSchemaSupport(node);
      if (!details) { return; }

      const name = await window.showInputBox({
        title: "Create Schema",
        prompt: "Name for the new schema",
        placeHolder: "e.g. SALES",
        validateInput: v => IDENTIFIER_RE.test(v.trim())
          ? undefined
          : "Enter a valid identifier (letters, digits, _, $ — must not start with a digit)",
      });
      if (!name) { return; }

      try {
        await Driver.runQuery(createSchemaQuery(name.trim().toUpperCase()), details);
        logger.showInfo(`Schema ${name.trim().toUpperCase()} created.`);
        firebirdTreeDataProvider.refresh();
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError(`Could not create the schema: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    commands.registerCommand("firebird.database.newQueryInSchema", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      const details = await requireSchemaSupport(node);
      if (!details) { return; }

      let schemas: string[];
      try {
        const rows = await Driver.runQuery(getSchemasQuery(), details);
        schemas = (rows ?? []).map((r: any) => String(r.SCHEMA_NAME).trim());
      } catch (err: any) {
        logger.showError(`Could not list schemas: ${err?.message ?? err}`);
        return;
      }
      if (schemas.length === 0) {
        logger.showInfo("This database has no user schemas.");
        return;
      }

      const picked = await window.showQuickPick(schemas, {
        placeHolder: "Unqualified names in the new query will resolve in this schema",
      });
      if (!picked) { return; }

      Global.activeConnection = details;
      // Seeds the statement rather than configuring the connection: the search path is session
      // state, and this extension's queries run over a pooled connection whose session the user
      // does not control. Putting it in the document means what runs is what you can see — and it
      // travels with the file if it is saved or shared.
      await Driver.createSQLTextDocument(`${setSearchPathQuery(picked)}\n\n`);
    })
  );

  context.subscriptions.push(
    commands.registerCommand("firebird.database.alterSchema", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      const details = await requireSchemaSupport(node);
      if (!details) { return; }

      let schemas: string[];
      try {
        const rows = await Driver.runQuery(getSchemasQuery(), details);
        schemas = (rows ?? []).map((r: any) => String(r.SCHEMA_NAME).trim());
      } catch (err: any) {
        logger.showError(`Could not list schemas: ${err?.message ?? err}`);
        return;
      }
      if (schemas.length === 0) {
        logger.showInfo("This database has no user schemas.");
        return;
      }

      const schema = await window.showQuickPick(schemas, { placeHolder: "Select a schema to alter" });
      if (!schema) { return; }

      const property = await window.showQuickPick(
        [
          { label: "Default SQL security", detail: "Whether routines in this schema run as their definer or their invoker" },
          { label: "Default character set", detail: "The character set new columns in this schema default to" },
        ],
        { placeHolder: `What should change about ${schema}?` }
      );
      if (!property) { return; }

      let statement: string;
      if (property.label === "Default SQL security") {
        const picked = await window.showQuickPick(["DEFINER", "INVOKER"], {
          placeHolder: "SQL SECURITY",
        });
        if (!picked) { return; }
        statement = alterSchemaQuery(schema, { sqlSecurity: picked as "DEFINER" | "INVOKER" });
      } else {
        const charset = await window.showInputBox({
          title: `Default character set for ${schema}`,
          placeHolder: "e.g. UTF8",
          validateInput: v => IDENTIFIER_RE.test(v.trim()) ? undefined : "Enter a character set name (e.g. UTF8)",
        });
        if (!charset) { return; }
        statement = alterSchemaQuery(schema, { characterSet: charset.trim().toUpperCase() });
      }

      try {
        await Driver.runQuery(statement, details);
        logger.showInfo(`Schema ${schema} altered.`);
        firebirdTreeDataProvider.refresh();
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError(`Could not alter the schema: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    commands.registerCommand("firebird.database.dropSchema", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      const details = await requireSchemaSupport(node);
      if (!details) { return; }

      let schemas: string[];
      try {
        const rows = await Driver.runQuery(getSchemasQuery(), details);
        schemas = (rows ?? []).map((r: any) => String(r.SCHEMA_NAME).trim());
      } catch (err: any) {
        logger.showError(`Could not list schemas: ${err?.message ?? err}`);
        return;
      }
      if (schemas.length === 0) {
        logger.showInfo("This database has no user schemas to drop.");
        return;
      }

      const picked = await window.showQuickPick(schemas, { placeHolder: "Select a schema to drop" });
      if (!picked) { return; }

      // Firebird refuses to drop a non-empty schema, so this cannot silently take tables with it —
      // but it is still a destructive DDL statement, so it gets a modal confirmation like the
      // other drops in this extension.
      const confirm = await window.showWarningMessage(
        `Drop schema ${picked}? Firebird will refuse if it still contains objects.`,
        { modal: true },
        "Drop Schema"
      );
      if (confirm !== "Drop Schema") { return; }

      try {
        await Driver.runQuery(dropSchemaQuery(picked), details);
        logger.showInfo(`Schema ${picked} dropped.`);
        firebirdTreeDataProvider.refresh();
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError(`Could not drop the schema: ${err?.message ?? err}`);
      }
    })
  );

  /* Forget every stored password — the only way to clear secrets the extension can now see. */
  context.subscriptions.push(
    commands.registerCommand("firebird.clearStoredPasswords", async () => {
      const stored = await CredentialStore.listStoredConnectionIds();
      const total = new Set([...stored.passwords, ...stored.sshPasswords]).size;
      if (total === 0) {
        logger.showInfo("No stored Firebird passwords to clear.");
        return;
      }
      const confirm = await window.showWarningMessage(
        `Forget stored passwords for ${total} Firebird connection(s)? You'll be asked for them again next time you connect.`,
        { modal: true },
        "Forget Passwords"
      );
      if (confirm !== "Forget Passwords") {
        return;
      }
      // An empty live set means "nothing is live", i.e. delete them all.
      const removed = await CredentialStore.deleteOrphans([]);
      logger.showInfo(`Cleared ${removed} stored password(s).`);
    })
  );

  /**
   * A NodeDatabase for a command that may have been invoked from the Command Palette.
   *
   * Tree context-menu invocations pass the node; the palette passes nothing, which used to mean
   * these commands simply threw. Falling back to the connection picker makes them reachable
   * without a tree click — and, incidentally, testable, since the palette is the only entry point
   * an automated UI test can drive.
   */
  const resolveDatabaseNode = async (node?: NodeDatabase): Promise<NodeDatabase | undefined> => {
    if (node) { return node; }
    const picked = await pickConnectionOptions(context);
    return picked ? new NodeDatabase(picked) : undefined;
  };

  /* DB ITEM: the schema unqualified names resolve through on this connection (Firebird 6+).
     Optional node argument so the Command Palette can reach it, like its neighbours. */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setDefaultSchema", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      node?.setDefaultSchema(context, firebirdTreeDataProvider).catch(err => logger.error(err));
    })
  );

  /* DB ITEM: set/update the stored password for this connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setPassword", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      node?.setPassword().catch(err => logger.error(err));
    })
  );

  /* DB ITEM: copy a Firebird-native (host/port:database) connection string, password excluded */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.copyConnectionString", (databaseNode: NodeDatabase) => {
      databaseNode.copyConnectionString().catch(err => logger.error(err));
    })
  );

  /* DB ITEM: set/update the stored SSH tunnel password/passphrase for this connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setSshTunnelPassword", (databaseNode: NodeDatabase) => {
      databaseNode.setSshTunnelPassword().catch(err => logger.error(err));
    })
  );

  /* DB ITEM: choose active database */
  context.subscriptions.push(
    commands.registerCommand("firebird.chooseActive", () => {
      connectionPicker(context)
        .then(pickedConnection => {
          if (pickedConnection?.detail) {
            const id = pickedConnection.detail.split(": ").pop();
            if (!id) { return; }
            Global.setActiveConnectionById(context, id).catch(err => {
              logger.error(err);
            });
          }
        })
        .catch(err => {
          logger.error(err.message);
          logger.showError(err.message, ["Cancel", "Add New Connection"]).then(res => {
            if (res === "Add New Connection") {
              firebirdTreeDataProvider.addConnection().catch(err => {
                logger.error(err);
              });
            }
          });
        });
    })
  );

  /**
   * Connection Lost Indicator (docs/roadmap/connection-lost-indicator.md), phase 2 -- one-click
   * reconnect for the currently active connection, wired up as the status bar item's own command
   * while it's showing its "connection lost" warning state (see Global.updateStatusBarItems()).
   * Reuses attemptConnection() (a real connect-then-detach, no throw) -- the same probe already
   * used by the connection wizard's own "Test Connection" step.
   */
  context.subscriptions.push(
    commands.registerCommand("firebird.reconnectActive", async () => {
      if (!Global.activeConnection) {
        logger.showError("No active database to reconnect to.");
        return;
      }
      const resolved = await Driver.resolvePassword(Global.activeConnection);
      const error = await attemptConnection(resolved);
      Global.reportConnectionOutcome(resolved.id, error ? new Error(error) : undefined);
      if (error) {
        logger.showError(`Reconnect failed: ${error}`);
      } else {
        logger.showInfo("Reconnected.");
      }
    })
  );

  /* DB ITEM: create new sql document */
  context.subscriptions.push(
    commands.registerCommand("firebird.newQuery", (databaseNode: NodeDatabase) => {
      databaseNode.newQuery();
    })
  );

  /* DB ITEM: remove database from explorer view */
  context.subscriptions.push(
    commands.registerCommand("firebird.removeDatabase", (databaseNode: NodeDatabase) => {
      databaseNode.removeDatabase(context, firebirdTreeDataProvider);
    })
  );

  /* DB ITEM: tag this connection with a color (tree icon + status bar) */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setConnectionColor", (databaseNode: NodeDatabase) => {
      databaseNode.setConnectionColor(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
      });
    })
  );

  /* DB ITEM: organize this connection under a named group/folder in the tree */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setConnectionGroup", (databaseNode: NodeDatabase) => {
      databaseNode.setConnectionGroup(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
      });
    })
  );

  /* DB ITEM: opt this connection in/out of the firebird-mcp MCP server's tools */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.toggleMcpExposure", (databaseNode: NodeDatabase) => {
      databaseNode.toggleMcpExposure(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
      });
    })
  );

  /* DB ITEM: opt this connection in/out of the firebird-mcp MCP server's run_write_query tool */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.toggleMcpWriteAccess", (databaseNode: NodeDatabase) => {
      databaseNode.toggleMcpWriteAccess(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
      });
    })
  );

  /* DB ITEM: rename an embedded database's file on disk */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.renameDatabase", (databaseNode: NodeDatabase) => {
      databaseNode.renameDatabase(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Rename Database failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB ITEM: edit an existing connection's fields, pre-filled, saved back over the same id */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.editConnection", (databaseNode: NodeDatabase) => {
      databaseNode.editConnection(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Edit Connection failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB ITEM: permanently drop the database itself (not just its saved connection entry) */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.dropDatabase", async (databaseNode: NodeDatabase) => {
      const answer = await vscode.window.showWarningMessage(
        "Permanently drop this database? This deletes every table, view, and row in it — there is no undo.",
        { modal: true },
        "Drop Database"
      );
      if (answer !== "Drop Database") { return; }
      databaseNode.dropDatabase(context, firebirdTreeDataProvider).catch(err => {
        logger.error(err?.message ?? err);
      });
    })
  );

  /**
   * The document the last batch was run from, if it was run from one. Held so that clicking a
   * failed statement's reported line in the results panel can jump back to it — the webview
   * knows the line, only this side knows the file.
   */
  let lastBatchDocument: vscode.TextDocument | undefined;

  /* "Line 12, column 8" clicked in a failed statement's result tab. */
  firebirdQueryResults.on("revealStatement", (data: RevealStatementRequest) => {
    if (!lastBatchDocument) { return; }
    const position = new vscode.Position(Math.max(0, data.line - 1), Math.max(0, data.column - 1));
    Promise.resolve(
      window.showTextDocument(lastBatchDocument, { selection: new vscode.Range(position, position) })
    ).catch((err: any) => logger.error(err?.message ?? err));
  });

  /**
   * Shared implementation behind both "Run Firebird Query" and "Run Statement Under Cursor":
   * executes `sql` (or, when omitted, Driver.runBatch()'s own selection/whole-document default)
   * and routes the results the same way for both — a lone DDL/DML statement becomes an info
   * notification plus an explorer refresh, anything else goes to the results webview. Kept as one
   * function so the two commands can't drift apart on the DDL/refresh handling or on the
   * notify-vs-generic error branches, as they previously had.
   */
  const runSqlBatch = (sql?: string, origin?: BatchOrigin) => {
    // Where the SQL about to run sits in a document, when it sits in one at all. Two cases: the
    // caller picked the text out itself (Run Statement Under Cursor, which passes its origin), or
    // the driver is about to fall back to the active editor — in which case the same helper the
    // driver uses reports what it will choose, so the offsets cannot disagree with the text.
    const source = origin ?? (sql === undefined ? activeEditorSql() : undefined);
    lastBatchDocument = source?.document;

    Driver.runBatch(sql)
      .then(rawResults => {
        // Driver.runBatch() already logged each statement to session history
        // via the historyLogger registered above.

        // Positions come back counted from the start of the text that was executed. That is the
        // document only when the whole document was run; for a selection or a single statement it
        // has to be lifted onto the document before anyone is shown a line number.
        const batchResults = source ? locateInDocument(rawResults, source) : rawResults;
        if (source) {
          executionDiagnostics.report(source.document, source.sql, source.baseOffset, rawResults);
        }

        // If every result is a DDL/DML message (no row data), show notification
        const allMessages = batchResults.every(r => !r.rows && !r.error);
        if (allMessages && batchResults.length === 1 && batchResults[0].message) {
          logger.info(batchResults[0].message);
          logger.showInfo(batchResults[0].message);
          commands.executeCommand("firebird.explorer.refresh");
        } else {
          firebirdQueryResults.displayBatch(batchResults, config.recordsPerPage, source !== undefined);
        }
      })
      .catch(error => {
        logger.error(error.message ?? error);
        if (error.notify) {
          logger.showError(error.message, error.options || []).then(selected => {
            if (selected === "New SQL Document") {
              commands.executeCommand("firebird.explorer.newSqlDocument");
            }
            if (selected === "Set Active Database") {
              commands.executeCommand("firebird.chooseActive");
            }
          });
        } else {
          logger
            .showError("Oops! Something went wrong. Check the log output for more details!", [
              "Cancel",
              "Show Log Output"
            ])
            .then(selected => {
              if (selected === "Show Log Output") {
                logger.showOutput();
              }
            });
        }
      });
  };

  /* COMMAND: run document query (batch-aware) */
  context.subscriptions.push(
    commands.registerCommand("firebird.runQuery", () => runSqlBatch())
  );

  /**
   * "Run Statement Under Cursor" (docs/roadmap/run-statement-under-cursor.md) -- runs just the one
   * statement the cursor happens to be positioned inside, out of a multi-statement document,
   * without requiring a selection. Only attempts the cursor lookup when there's no selection (an
   * actual highlighted selection is left to the shared runner's existing selection-aware default,
   * unchanged); a cursor sitting in pure inter-statement whitespace also falls back to that same
   * default (whole document) rather than erroring, per the roadmap doc's own phase 1. That
   * fallback goes through runSqlBatch() -- i.e. Driver.runBatch(), not Driver.runQuery() -- so a
   * whole multi-statement document is split and run statement by statement exactly as "Run
   * Firebird Query" does, rather than being sent to the server as one unsplit blob that fails at
   * the first `;`.
   */
  context.subscriptions.push(
    commands.registerCommand("firebird.runCurrentStatement", () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== "sql") {
        logger.showError("Open a .sql file and place your cursor in a query first.");
        return;
      }

      let sql: string | undefined;
      let origin: BatchOrigin | undefined;
      if (editor.selection.isEmpty) {
        const offset = editor.document.offsetAt(editor.selection.active);
        const statement = splitStatementsWithOffsets(editor.document.getText())
          .find(range => offset >= range.start && offset <= range.end);
        sql = statement?.text;
        // The statement's own start is the base offset here: its line 1 is wherever in the file it
        // happens to begin, and a failure in it must name that line, not line 1.
        if (statement) {
          origin = { document: editor.document, sql: statement.text, baseOffset: statement.start };
        }
      }

      runSqlBatch(sql, origin);
    })
  );

  /**
   * Quick Queries (docs/roadmap/quick-queries.md) — `firebird.quickQuery.1` … `.9`, each running
   * the SQL configured for that slot. Contributed with no default keybindings: users bind whichever
   * slots they want in VS Code's own Keyboard Shortcuts editor, which is the whole point (a fixed
   * numbered command set is the only way to offer "bind an arbitrary saved query to a key", since
   * keybindings are static in package.json and extensions can't mint commands at runtime).
   *
   * A slot resolves from the `firebird.quickQueries` setting first, then from a bookmark that's
   * been assigned to it — the setting wins, per the roadmap doc.
   */
  const runQuickQuery = async (slot: number) => {
    const fromSetting = resolveQuickQuery(config.quickQueries, slot);
    const fromBookmark = fromSetting ? undefined : findBookmarkForSlot(bookmarkProvider.getAll(), slot);
    const quickQuery: QuickQuery | undefined = fromSetting
      ?? (fromBookmark ? { name: fromBookmark.name, sql: fromBookmark.sql, action: "run" } : undefined);

    if (!quickQuery) {
      const selected = await logger.showError(
        `No query is configured for Quick Query ${slot}.`,
        ["Cancel", "Configure Quick Queries"]
      );
      if (selected === "Configure Quick Queries") {
        commands.executeCommand("workbench.action.openSettings", "firebird.quickQueries");
      }
      return;
    }

    // The selection is read from whatever editor is active — deliberately not restricted to SQL
    // documents, since ${selectedText} is just as useful over a table name highlighted in a log,
    // a migration script, or a code file.
    const editor = window.activeTextEditor;
    const selectedText = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : undefined;

    const substituted = applySelectedText(quickQuery.sql, selectedText);
    if (!substituted.ok) {
      logger.showError(`${quickQuery.name}: ${substituted.reason}`);
      return;
    }

    if (quickQuery.action === "open") {
      await Driver.createSQLTextDocument(substituted.sql);
      return;
    }
    runSqlBatch(substituted.sql);
  };

  for (let slot = 1; slot <= QUICK_QUERY_SLOT_COUNT; slot++) {
    context.subscriptions.push(
      commands.registerCommand(`firebird.quickQuery.${slot}`, () => runQuickQuery(slot))
    );
  }

  /* COMMAND: run the current query with named :paramName placeholders, prompting for each
     value's type and value before rewriting them to positional ? placeholders and binding them
     through Driver.runQuery()'s params argument. */
  context.subscriptions.push(
    commands.registerCommand("firebird.runParameterizedQuery", async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== "sql") {
        logger.showError("Open a .sql file and select (or place your cursor in) a query first.");
        return;
      }
      const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      if (!sql.trim()) {
        logger.showError("No SQL found to run.");
        return;
      }

      const paramNames = extractNamedParameters(sql);
      if (paramNames.length === 0) {
        logger.showError("No :namedParameters found in this query. Use \"Run Firebird Query\" for a plain query.");
        return;
      }
      if (!Global.activeConnection) {
        logger.showError("No Firebird database selected!");
        return;
      }

      const typeItems: {label: string; value: ParamType}[] = [
        {label: "String", value: "string"},
        {label: "Integer", value: "integer"},
        {label: "Float", value: "float"},
        {label: "Date/Timestamp", value: "date"},
        {label: "Boolean", value: "boolean"},
        {label: "NULL", value: "null"},
      ];

      const valuesByName = new Map<string, any>();
      for (const name of paramNames) {
        const typeChoice = await window.showQuickPick(typeItems, {
          title: `Parameter :${name} — select its type (${paramNames.indexOf(name) + 1}/${paramNames.length})`,
          ignoreFocusOut: true,
        });
        if (!typeChoice) { return; }

        let raw: string | undefined;
        if (typeChoice.value !== "null") {
          raw = await window.showInputBox({
            title: `Parameter :${name} — enter a ${typeChoice.label} value`,
            ignoreFocusOut: true,
          });
          if (raw === undefined) { return; }
        }

        try {
          valuesByName.set(name, coerceParamValue(typeChoice.value, raw));
        } catch (err: any) {
          logger.showError(err?.message ?? String(err));
          return;
        }
      }

      const {sql: positionalSql, paramNames: bindOrder} = rewriteNamedParametersToPositional(sql);
      const params = bindOrder.map(name => valuesByName.get(name));

      Driver.runQuery(positionalSql, Global.activeConnection, params)
        .then(result => {
          firebirdQueryResults.display(result, config.recordsPerPage);
        })
        .catch((err: any) => {
          logger.error(err?.message ?? err);
          logger.showError(`Query failed: ${err?.message ?? err}`);
        });
    })
  );

  // PREDEFINED QUERY COMMANDS

  /* DB ITEM: show database info */
  context.subscriptions.push(
    commands.registerCommand("firebird.showDatabaseInfo", (databaseNode: NodeDatabase) => {
      databaseNode.showDatabaseInfo().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage);
      });
    })
  );

  /* COMMAND tables node: show table info */
  context.subscriptions.push(
    commands.registerCommand("firebird.showTableInfo", (tableNode: NodeTable) => {
      tableNode
        .showTableInfo()
        .then(result => {
          firebirdQueryResults.display(result, config.recordsPerPage);
        })
        .catch(err => {
          logger.error(err);
          logger
            .showError("Ooops! Something went wrong! Check the log details for more info.", [
              "Cancel",
              "Show Log Details"
            ])
            .then(res => {
              if (res === "Show Log Details") {
                logger.showOutput();
              }
            });
        });
    })
  );

  /* COMMAND tables node: select all records */
  context.subscriptions.push(
    commands.registerCommand("firebird.selectAllRecords", (tableNode: NodeTable) => {
      tableNode.selectAllRecords().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage, tableNode.getTableName(), {
          sql: tableNode.getSelectAllSql(),
          probedForMore: true,
        });
      });
    })
  );

  /* COMMAND table node: edit data in interactive grid */
  context.subscriptions.push(
    commands.registerCommand("firebird.table.editData", (tableNode: NodeTable) => {
      tableNode.selectAllRecords().then(result => {
        firebirdQueryResults.displayEditable(result, config.recordsPerPage, tableNode.getTableName(), {
          sql: tableNode.getSelectAllSql(),
          probedForMore: true,
        });
      });
    })
  );

  /* COMMAND global object search */
  context.subscriptions.push(
    commands.registerCommand("firebird.globalSearch", async (databaseNode?: NodeDatabase) => {
      const activeConn = databaseNode?.dbDetails ?? getActiveConnection();
      if (!activeConn) {
        vscode.window.showErrorMessage("No active Firebird connection selected. Connect to a database or select a database node in Object Explorer.");
        return;
      }
      await runObjectSearch(activeConn, firebirdQueryResults);
    })
  );

  /* COMMAND table node: drop selected table */
  context.subscriptions.push(
    commands.registerCommand("firebird.table.dropTable", async (tableNode: NodeTable) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this table?", "Yes", "No");
      if (answer === "Yes") {
        tableNode.dropTable();
      }
    })
  );

  /* COMMAND field node: select all records for single field */
  context.subscriptions.push(
    commands.registerCommand("firebird.selectFieldRecords", (fieldNode: NodeField) => {
      fieldNode.selectAllSingleFieldRecords().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage, fieldNode.getTableName(), {
          sql: fieldNode.getSelectAllSql(),
        });
      });
    })
  );

  /* COMMAND view node: select all view records */
  context.subscriptions.push(
    commands.registerCommand("firebird.selectAllViewRecords", (viewNode: NodeView) => {
      viewNode.selectAllRecords().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage, viewNode.getViewName(), {
          sql: viewNode.getSelectAllSql(),
          probedForMore: true,
        });
      });
    })
  );

  /* DDL: alter table via the Schema Designer */
  context.subscriptions.push(
    commands.registerCommand("firebird.table.alterTable", (tableNode: NodeTable) => {
      tableNode.alterTable(firebirdSchemaDesigner);
    })
  );

  /* DDL: open the Schema Designer with a blank new table */
  context.subscriptions.push(
    commands.registerCommand("firebird.table.createTable", () => {
      firebirdSchemaDesigner.openNewTable(Global.activeConnection);
    })
  );

  /* DDL: create procedure scaffold */
  context.subscriptions.push(
    commands.registerCommand("firebird.procedure.createProcedure", async () => {
      const procedureName = await promptIdentifier("Name of the new procedure", "e.g. GET_ACTIVE_CUSTOMERS");
      if (!procedureName) { return; }
      NodeProcedure.createProcedure(procedureName);
    })
  );

  /* DDL: edit procedure source */
  context.subscriptions.push(
    commands.registerCommand("firebird.procedure.editProcedure", (procNode: NodeProcedure) => {
      procNode.editProcedure().catch(err => logger.error(err));
    })
  );

  /* DDL: drop procedure */
  context.subscriptions.push(
    commands.registerCommand("firebird.procedure.dropProcedure", async (procNode: NodeProcedure) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this procedure?", "Yes", "No");
      if (answer === "Yes") {
        procNode.dropProcedure();
      }
    })
  );

  /* DDL: create trigger scaffold */
  context.subscriptions.push(
    commands.registerCommand("firebird.trigger.createTrigger", async () => {
      const triggerName = await promptIdentifier("Name of the new trigger", "e.g. CUSTOMERS_BI");
      if (!triggerName) { return; }
      NodeTrigger.createTrigger(triggerName);
    })
  );

  /* DDL: edit trigger source */
  context.subscriptions.push(
    commands.registerCommand("firebird.trigger.editTrigger", (triggerNode: NodeTrigger) => {
      triggerNode.editTrigger().catch(err => logger.error(err));
    })
  );

  /* DDL: drop trigger */
  context.subscriptions.push(
    commands.registerCommand("firebird.trigger.dropTrigger", async (triggerNode: NodeTrigger) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this trigger?", "Yes", "No");
      if (answer === "Yes") {
        triggerNode.dropTrigger();
      }
    })
  );

  /* DDL: create view scaffold */
  context.subscriptions.push(
    commands.registerCommand("firebird.view.createView", async () => {
      const viewName = await promptIdentifier("Name of the new view", "e.g. ACTIVE_CUSTOMERS");
      if (!viewName) { return; }
      NodeView.createView(viewName);
    })
  );

  /* DDL: edit view definition */
  context.subscriptions.push(
    commands.registerCommand("firebird.view.editView", (viewNode: NodeView) => {
      viewNode.editView().catch(err => logger.error(err));
    })
  );

  /* DDL: drop view */
  context.subscriptions.push(
    commands.registerCommand("firebird.view.dropView", async (viewNode: NodeView) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this view?", "Yes", "No");
      if (answer === "Yes") {
        viewNode.dropView();
      }
    })
  );

  /* DDL: create generator/sequence */
  context.subscriptions.push(
    commands.registerCommand("firebird.generator.createGenerator", async () => {
      if (!Global.activeConnection) {
        logger.showError("Set a database active first.");
        return;
      }
      const generatorName = await promptIdentifier("Name of the new generator/sequence", "e.g. GEN_CUSTOMER_ID");
      if (!generatorName) { return; }
      NodeGenerator.createGenerator(Global.activeConnection, generatorName);
    })
  );

  /* DDL: set generator value */
  context.subscriptions.push(
    commands.registerCommand("firebird.generator.setValue", (genNode: NodeGenerator) => {
      genNode.setGeneratorValue().catch(err => logger.error(err));
    })
  );

  /* DDL: drop generator */
  context.subscriptions.push(
    commands.registerCommand("firebird.generator.dropGenerator", async (genNode: NodeGenerator) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this generator/sequence?", "Yes", "No");
      if (answer === "Yes") {
        genNode.dropGenerator();
      }
    })
  );

  /* DDL: create domain scaffold */
  context.subscriptions.push(
    commands.registerCommand("firebird.domain.createDomain", async () => {
      const domainName = await promptIdentifier("Name of the new domain", "e.g. D_EMAIL");
      if (!domainName) { return; }
      NodeDomain.createDomain(domainName);
    })
  );

  /* DDL: alter domain scaffold */
  context.subscriptions.push(
    commands.registerCommand("firebird.domain.alterDomain", (domainNode: NodeDomain) => {
      domainNode.alterDomain().catch(err => logger.error(err));
    })
  );

  /* DDL: drop domain */
  context.subscriptions.push(
    commands.registerCommand("firebird.domain.dropDomain", async (domainNode: NodeDomain) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this domain?", "Yes", "No");
      if (answer === "Yes") {
        domainNode.dropDomain();
      }
    })
  );

  /* DDL: drop role */
  context.subscriptions.push(
    commands.registerCommand("firebird.role.dropRole", async (roleNode: NodeRole) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this role?", "Yes", "No");
      if (answer === "Yes") {
        roleNode.dropRole();
      }
    })
  );

  /* DDL: drop exception */
  context.subscriptions.push(
    commands.registerCommand("firebird.exception.dropException", async (exceptionNode: NodeException) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this exception?", "Yes", "No");
      if (answer === "Yes") {
        exceptionNode.dropException();
      }
    })
  );

  /* DDL: create role */
  context.subscriptions.push(
    commands.registerCommand("firebird.role.createRole", async () => {
      if (!Global.activeConnection) {
        logger.showError("Set a database active first.");
        return;
      }
      const roleName = await vscode.window.showInputBox({
        prompt: "Name of the new role",
        placeHolder: "e.g. APP_ADMIN",
        ignoreFocusOut: true,
        validateInput: v => IDENTIFIER_RE.test(v) ? undefined : "Enter a valid identifier (letters, digits, _, $ — must not start with a digit)"
      });
      if (!roleName) { return; }
      NodeRole.createRole(Global.activeConnection, roleName);
    })
  );

  /* DDL: create user */
  context.subscriptions.push(
    commands.registerCommand("firebird.user.createUser", async () => {
      if (!Global.activeConnection) {
        logger.showError("Set a database active first.");
        return;
      }
      const userName = await vscode.window.showInputBox({
        prompt: "Name of the new user",
        placeHolder: "e.g. APP_USER",
        ignoreFocusOut: true,
        validateInput: v => IDENTIFIER_RE.test(v) ? undefined : "Enter a valid identifier (letters, digits, _, $ — must not start with a digit)"
      });
      if (!userName) { return; }
      const password = await vscode.window.showInputBox({
        prompt: `Password for ${userName}`,
        ignoreFocusOut: true,
        password: true,
        validateInput: v => v ? undefined : "Password is required"
      });
      if (!password) { return; }
      NodeUser.createUser(Global.activeConnection, userName, password);
    })
  );

  /* DDL: drop user */
  context.subscriptions.push(
    commands.registerCommand("firebird.user.dropUser", async (userNode: NodeUser) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this user?", "Yes", "No");
      if (answer === "Yes") {
        userNode.dropUser();
      }
    })
  );

  /* DDL: change user password */
  context.subscriptions.push(
    commands.registerCommand("firebird.user.changePassword", async (userNode: NodeUser) => {
      const password = await vscode.window.showInputBox({
        prompt: "New password",
        ignoreFocusOut: true,
        password: true,
        validateInput: v => v ? undefined : "Password is required"
      });
      if (!password) { return; }
      userNode.changePassword(password);
    })
  );

  /* DDL: create index */
  context.subscriptions.push(
    commands.registerCommand("firebird.index.createIndex", async (folderNode: NodeIndexFolder) => {
      if (!Global.activeConnection) {
        logger.showError("Set a database active first.");
        return;
      }
      const indexName = await vscode.window.showInputBox({
        prompt: "Name of the new index",
        placeHolder: "e.g. IDX_CUSTOMERS_EMAIL",
        ignoreFocusOut: true,
        validateInput: v => IDENTIFIER_RE.test(v) ? undefined : "Enter a valid identifier (letters, digits, _, $ — must not start with a digit)"
      });
      if (!indexName) { return; }

      const columnsInput = await vscode.window.showInputBox({
        prompt: `Column(s) to index on ${folderNode.getTableName()} (comma-separated)`,
        placeHolder: "e.g. LAST_NAME, FIRST_NAME",
        ignoreFocusOut: true,
        validateInput: v => v.trim() ? undefined : "At least one column is required"
      });
      if (!columnsInput) { return; }
      const columns = columnsInput.split(",").map(c => c.trim()).filter(c => c.length > 0);

      const uniquePick = await vscode.window.showQuickPick(
        [
          { label: "Regular Index", description: "Allows duplicate values" },
          { label: "Unique Index", description: "Rejects duplicate values" }
        ],
        { placeHolder: "Index type", ignoreFocusOut: true }
      );
      if (!uniquePick) { return; }

      NodeIndex.createIndex(Global.activeConnection, folderNode.getTableName(), indexName, columns, uniquePick.label === "Unique Index");
    })
  );

  /* DDL: drop index */
  context.subscriptions.push(
    commands.registerCommand("firebird.index.dropIndex", async (indexNode: NodeIndex) => {
      const answer = await vscode.window.showInformationMessage("Do you really want to drop this index?", "Yes", "No");
      if (answer === "Yes") {
        indexNode.dropIndex();
      }
    })
  );

  /* DB: monitor active connections — opens the Live Profiler.
     Takes an optional node so the Command Palette can reach it: without the fallback the command
     is right-click-only, which is both awkward for users and untestable — see
     docs/roadmap/webview-ui-testing.md, where the same gap kept the Schema Designer uncovered. */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.monitorDatabase", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      node.monitorDatabase(firebirdProfilerView).catch(err => {
        logger.error(err.message ?? err);
        logger.showError("Could not open the Live Profiler. Check logs for details.", ["Show Log Output"]).then(sel => {
          if (sel === "Show Log Output") { logger.showOutput(); }
        });
      });
    })
  );

  context.subscriptions.push(
    commands.registerCommand("firebird.database.performanceDashboard", async (databaseNode?: NodeDatabase) => {
      return commands.executeCommand("firebird.database.monitorDatabase", databaseNode);
    })
  );

  /* DB: guided flat-file (CSV/TSV/JSON) import wizard */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.importFlatFile", (databaseNode: NodeDatabase) => {
      databaseNode.importFlatFile().catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Flat file import failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB: generate an OpenAPI Data API spec from the connected schema */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.generateDataApiSpec", (databaseNode: NodeDatabase) => {
      databaseNode.generateDataApiSpec().catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Data API spec generation failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB: same, scoped by a Copilot-interpreted plain-English description of what to expose */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.generateDataApiSpecWithCopilot", (databaseNode: NodeDatabase) => {
      databaseNode.generateDataApiSpecWithCopilot().catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Data API spec generation failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB: fuzzy-search every object by name, then jump to its most useful action */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.searchObjects", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      if (!node) { return; }
      node.searchObjects(firebirdQueryResults).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Object Search failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB: extract the connected schema into a Database Project folder */
  context.subscriptions.push(
    commands.registerCommand("firebird.project.extract", (databaseNode: NodeDatabase) => {
      databaseNode.extractProject().catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Database Project extract failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* Build a Database Project folder into one reviewable deploy script */
  context.subscriptions.push(
    commands.registerCommand("firebird.project.build", () => {
      runBuildProject().catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Database Project build failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* Publish/migrate a Database Project against a live target connection (diff -> executable ALTER script) */
  context.subscriptions.push(
    commands.registerCommand("firebird.project.publish", () => {
      runPublishProject(context).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Database Project publish failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* DB: backup database */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.backupDatabase", async (databaseNode: NodeDatabase) => {
      const gbak = await resolveGbakExecutable(getOptions().gbakPath || undefined, checkGbakExecutable);
      if (!gbak) {
        logger.showError("Could not find the gbak executable. Install the Firebird server/client tools, or set the firebird.gbakPath setting.");
        return;
      }
      databaseNode.backupDatabase(taskTracker, gbak).catch(err => logger.error(err));
    })
  );

  /* DB: restore database */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.restoreDatabase", async (databaseNode: NodeDatabase) => {
      const gbak = await resolveGbakExecutable(getOptions().gbakPath || undefined, checkGbakExecutable);
      if (!gbak) {
        logger.showError("Could not find the gbak executable. Install the Firebird server/client tools, or set the firebird.gbakPath setting.");
        return;
      }
      databaseNode.restoreDatabase(taskTracker, gbak).catch(err => logger.error(err));
    })
  );

    /* COMMAND field node: open extension logs */
    context.subscriptions.push(
      commands.registerCommand("firebird.showLogs", () => {
        logger.showOutput();
      })
    );

  /* COMMAND field node: build native client */
  context.subscriptions.push(
    commands.registerCommand("firebird.buildNative", async () => {
      // TODO: precompile and just link it depending on the platform
      const answer = await vscode.window.showInformationMessage("Compile the native driver? (requires python to be installed)", "Yes", "No");
      if (answer === "Yes") {
        // Execute the npm script
        const child = cp.exec(`npm run install-native`, {cwd: context.extensionUri.fsPath});
        const statusIndicator = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        statusIndicator.text = "$(loading~spin) Compiling Native Driver...";
        statusIndicator.command = "firebird.showLogs";

        statusIndicator.show();

        // Capture and display the output of the npm script
        child.stdout?.on('data', (data) => {
          logger.output(`[node-gyp driver compilation] ${data}`);
        });

        // Handle any errors that occur during script execution
        child.on('error', (error) => {
          logger.showError(`Error: ${error.message}`);
        });

        // Listen for when the script process exits
        child.on('close', (code) => {
          statusIndicator.dispose();
          if (code) {
            logger.error(`Build failed: Terminal exited with code: ${code}`);
            logger.showError(`Build failed: Terminal exited with code: ${code}`);
          } else {
            window.showInformationMessage("Compiled Driver Successfully");
          }
        });
      }
    })
  );

  /* COMMAND: format SQL document */
  context.subscriptions.push(
    commands.registerCommand("firebird.formatSql", async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') {
        logger.showError("No SQL document is active.");
        return;
      }
      const document = editor.document;
      const text = document.getText();
      const formatted = formatSQL(text);
      if (formatted === text) {
        logger.showInfo("SQL document is already formatted.");
        return;
      }
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length)
      );
      await editor.edit(editBuilder => {
        editBuilder.replace(fullRange, formatted);
      });
    })
  );

  /* DB ITEM: visualize schema — entity-relationship diagram for a database */
  context.subscriptions.push(
    commands.registerCommand("firebird.schemaVisualizer.open", async (databaseNode?: NodeDatabase) => {
      const node = await resolveDatabaseNode(databaseNode);
      node?.openSchemaDesigner(firebirdSchemaDesigner);
    })
  );

  /* isql/isql-fb terminal integration (similar to "psql in the terminal" in Microsoft's
     PostgreSQL extension for VS Code) */

  // gbak's -z prints its banner and then exits non-zero, so the exit code can't be trusted;
  // probeGbak() encodes that (see src/shared/executable-probe.ts).
  const checkGbakExecutable = (candidate: string): Promise<boolean> => probeGbak(candidate);

  // isql -z reads stdin after printing its banner, and plain `isql` is often unixODBC's;
  // probeIsql() handles both (see src/shared/executable-probe.ts).
  const checkIsqlExecutable = (candidate: string): Promise<boolean> => probeIsql(candidate);

  /**
   * Resolves a terminal's shell integration, waiting briefly for the shell to activate it
   * (docs/roadmap/isql-terminal-shell-integration.md). `Terminal.shellIntegration` is undefined
   * until the shell reports in, and stays undefined forever for a shell that doesn't support it or
   * whose startup scripts suppress it — hence the timeout and the `undefined` result, which callers
   * must handle rather than assume away.
   */
  function waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs = 3000
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        subscription.dispose();
        resolve(undefined);
      }, timeoutMs);
      const subscription = window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal) {
          clearTimeout(timer);
          subscription.dispose();
          resolve(event.shellIntegration);
        }
      });
    });
  }

  /** How an isql launch's exit code should be interpreted — see launchIsqlTask(). */
  type IsqlLaunchMode = "interactive" | "script";

  /**
   * Launches isql in an integrated terminal (docs/roadmap/isql-terminal-shell-integration.md).
   *
   * Uses `window.createTerminal()` + the shell integration API rather than the Tasks API this
   * previously went through, for two reasons the roadmap doc records: a `vscode.Task` needs a
   * workspace folder, so opening a single .sql file with no folder open made both isql commands
   * unavailable for no reason intrinsic to isql; and `tasks.executeTask()` resolves when the task
   * *starts*, so nothing ever observed isql's exit code — a script that failed reported nothing at
   * all, unlike gbak backup/restore, which do check and fail visibly.
   *
   * Shell integration is best-effort: when it isn't available the command is still typed into the
   * terminal with `sendText()`, which loses the exit code but is never worse than the old behavior.
   */
  async function launchIsqlTask(
    connectionOptions: ConnectionOptions,
    taskName: string,
    extraArgs: string[] = [],
    mode: IsqlLaunchMode = "interactive"
  ): Promise<void> {
    const executable = await resolveIsqlExecutable(getOptions().isqlPath || undefined, checkIsqlExecutable);
    if (!executable) {
      logger.showError(
        "Could not find the isql (or isql-fb) executable. Install the Firebird client tools, or set the firebird.isqlPath setting.",
        ["Learn More"]
      ).then(selected => {
        if (selected === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://firebirdsql.org/en/firebird-clients/"));
        }
      });
      return;
    }

    const args = buildIsqlArgs(connectionOptions, extraArgs);
    const terminal = window.createTerminal({
      name: taskName,
      // Same reasoning as the old ShellExecution's own env: credentials go through ISC_USER/
      // ISC_PASSWORD so they never appear in the visible command line or a process listing.
      env: buildIsqlEnv(connectionOptions),
      iconPath: new vscode.ThemeIcon("database"),
    });
    terminal.show();

    const shellIntegration = await waitForShellIntegration(terminal);
    if (!shellIntegration) {
      logger.debug("isql: shell integration unavailable — falling back to sendText (no exit code).");
      terminal.sendText(buildIsqlCommandLine(executable, args), true);
      return;
    }

    const execution = shellIntegration.executeCommand(executable, args);
    const task = taskTracker.start(taskName);

    // The exit code arrives on window.onDidEndTerminalShellExecution, not on the execution itself.
    const exitCodePromise = new Promise<number | undefined>(resolve => {
      const subscription = window.onDidEndTerminalShellExecution(event => {
        if (event.execution === execution) {
          subscription.dispose();
          resolve(event.exitCode);
        }
      });
    });

    // Deliberately not awaited: an interactive isql session lasts until the user quits it, and this
    // function's callers only launch it. Completion is reported whenever it actually happens.
    void (async () => {
      try {
        // Output is only read for a script run — that's the case where isql's own error text is
        // worth quoting back. Draining an interactive session's stream would serve no purpose.
        let output = "";
        if (mode === "script") {
          for await (const chunk of execution.read()) {
            output += chunk;
            if (output.length > 64_000) {
              output = output.slice(-64_000); // keep the tail: the failure is at the end
            }
          }
        }

        const exitCode = await exitCodePromise;
        // Not `exitCode !== 0`: a failed *login* makes isql exit 0 while printing SQLSTATE 28000,
        // so the output has to be consulted too — see isqlRunFailed(). An `undefined` exit code is
        // documented as meaning several things (including a plain ctrl+c), so on its own it is not
        // treated as failure; that would false-alarm on a normal interactive quit.
        if (!isqlRunFailed(exitCode, output)) {
          task.complete();
          return;
        }

        const summary = summarizeIsqlFailure(exitCode, output);
        task.fail(summary);
        logger.error(`isql (${taskName}): ${summary}`);
        // Only a script run gets a notification. An interactive session ends however the user chose
        // to end it — Ctrl+C out of a prompt is a non-zero exit and emphatically not an error worth
        // interrupting them over; it's still recorded in the Background Tasks view either way.
        if (mode === "script") {
          logger.showError(`isql: ${summary}`, ["Show Log Output"]).then(selected => {
            if (selected === "Show Log Output") {
              logger.showOutput();
            }
          });
        }
      } catch (err: any) {
        task.fail(err?.message ?? String(err));
        logger.error(`isql (${taskName}) could not be tracked: ${err?.message ?? err}`);
      }
    })();
  }

  /* DB ITEM: connect with isql in an integrated terminal */
  context.subscriptions.push(
    commands.registerCommand("firebird.terminal.connectIsql", async (databaseNode?: NodeDatabase) => {
      try {
        let dbDetails: ConnectionOptions | undefined;
        if (databaseNode) {
          dbDetails = await databaseNode.getResolvedConnectionDetails();
        } else if (Global.activeConnection) {
          dbDetails = await Driver.resolvePassword(Global.activeConnection);
        }
        if (!dbDetails) {
          logger.showError("No Firebird database selected!", ["Cancel", "Set Active Database"]).then(selected => {
            if (selected === "Set Active Database") {
              commands.executeCommand("firebird.chooseActive");
            }
          });
          return;
        }
        await launchIsqlTask(dbDetails, `ISQL: ${getConnectionLabel(dbDetails)}`);
      } catch (err: any) {
        logger.error(err);
        logger.showError(`Failed to launch isql: ${err?.message ?? err}`);
      }
    })
  );

  /* EDITOR: run the active .sql file through isql */
  context.subscriptions.push(
    commands.registerCommand("firebird.terminal.runFileIsql", async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== "sql") {
        logger.showError("Open a SQL document to run it with isql.");
        return;
      }
      if (!Global.activeConnection) {
        logger.showError("No Firebird database selected!", ["Cancel", "Set Active Database"]).then(selected => {
          if (selected === "Set Active Database") {
            commands.executeCommand("firebird.chooseActive");
          }
        });
        return;
      }
      if (editor.document.isUntitled) {
        logger.showError("Save the file before running it with isql.");
        return;
      }
      await editor.document.save();
      if (editor.document.isDirty) {
        logger.showError("The file must be saved before running it with isql.");
        return;
      }

      try {
        const dbDetails = await Driver.resolvePassword(Global.activeConnection);
        const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? editor.document.fileName;
        await launchIsqlTask(dbDetails, `ISQL: ${fileName}`, ["-i", editor.document.fileName], "script");
      } catch (err: any) {
        logger.error(err);
        logger.showError(`Failed to launch isql: ${err?.message ?? err}`);
      }
    })
  );

  /* COMMAND: schema diff — compare two saved connections */
  context.subscriptions.push(
    commands.registerCommand("firebird.schemaDiff", async () => {
      const connections = context.globalState.get<{ [key: string]: import('./interfaces').ConnectionOptions }>(Constants.ConectionsKey);
      if (!connections || Object.keys(connections).length < 1) {
        logger.showError("Please add at least one database connection to use Schema Diff.");
        return;
      }

      const allConns = Object.values(connections);
      const items = allConns.map(c => ({
        label: c.embedded ? `[embedded] ${c.database}` : `${c.host}: ${c.database}`,
        detail: c.id,
        conn: c,
      }));

      const sourcePick = await window.showQuickPick(items, { placeHolder: "Select SOURCE database" });
      if (!sourcePick) { return; }

      const targetItems = items.filter(i => i.detail !== sourcePick.detail);
      if (targetItems.length === 0) {
        logger.showError("You need at least two database connections for Schema Diff.");
        return;
      }
      const targetPick = await window.showQuickPick(targetItems, { placeHolder: "Select TARGET database" });
      if (!targetPick) { return; }

      const maxTables = config.maxTablesCount;

      try {
        await window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Comparing schemas…", cancellable: false },
          async () => {
            const [sourceConn, targetConn] = await Promise.all([
              import('./shared/credential-store').then(m => m.CredentialStore.getPassword(sourcePick.conn.id)),
              import('./shared/credential-store').then(m => m.CredentialStore.getPassword(targetPick.conn.id)),
            ]);
            const src = { ...sourcePick.conn, password: sourceConn ?? "" };
            const tgt = { ...targetPick.conn, password: targetConn ?? "" };

            const [sourceSnapshot, targetSnapshot] = await Promise.all([
              fetchSchemaSnapshot(src, maxTables),
              fetchSchemaSnapshot(tgt, maxTables),
            ]);

            const diff = diffSchemas(sourceSnapshot, targetSnapshot);
            const report = renderDiffReport(diff, sourcePick.label, targetPick.label);

            const doc = await workspace.openTextDocument({ content: report, language: "plaintext" });
            await window.showTextDocument(doc, vscode.ViewColumn.Beside);
          }
        );
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError("Schema Diff failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      }
    })
  );

  /* COMMAND: schema diff — Markdown Preview (renders diff as a rich GFM document opened in VS Code's
     built-in Markdown preview). Uses a virtual-document TextDocumentContentProvider so no temp
     file is written to disk and the document auto-updates when the user re-runs the command. */
  context.subscriptions.push(
    commands.registerCommand("firebird.schemaDiff.markdownPreview", async () => {
      const connections = context.globalState.get<{ [key: string]: import('./interfaces').ConnectionOptions }>(Constants.ConectionsKey);
      if (!connections || Object.keys(connections).length < 1) {
        logger.showError("Please add at least one database connection to use Schema Diff Markdown Preview.");
        return;
      }

      const allConns = Object.values(connections);
      const items = allConns.map(c => ({
        label: c.embedded ? `[embedded] ${c.database}` : `${c.host}: ${c.database}`,
        detail: c.id,
        conn: c,
      }));

      const sourcePick = await window.showQuickPick(items, { placeHolder: "Select SOURCE database (the schema you want to compare FROM)" });
      if (!sourcePick) { return; }

      const targetItems = items.filter(i => i.detail !== sourcePick.detail);
      if (targetItems.length === 0) {
        // Single connection: compare the live database to itself — useful to confirm it matches
        // a project, but degenerate for a diff. Show a helpful message instead.
        logger.showError("You need at least two database connections to compare schemas.");
        return;
      }
      const targetPick = await window.showQuickPick(targetItems, { placeHolder: "Select TARGET database (the schema you want to compare TO)" });
      if (!targetPick) { return; }

      const maxTables = config.maxTablesCount;

      try {
        await window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Comparing schemas for Markdown preview…", cancellable: false },
          async () => {
            const [sourcePassword, targetPassword] = await Promise.all([
              import('./shared/credential-store').then(m => m.CredentialStore.getPassword(sourcePick.conn.id)),
              import('./shared/credential-store').then(m => m.CredentialStore.getPassword(targetPick.conn.id)),
            ]);
            const src = { ...sourcePick.conn, password: sourcePassword ?? "" };
            const tgt = { ...targetPick.conn, password: targetPassword ?? "" };

            const [sourceSnapshot, targetSnapshot] = await Promise.all([
              fetchSchemaSnapshot(src, maxTables),
              fetchSchemaSnapshot(tgt, maxTables),
            ]);

            const diff = diffSchemas(sourceSnapshot, targetSnapshot);
            const markdown = renderDiffMarkdown(diff, sourcePick.label, targetPick.label);

            // Open as a virtual markdown document and show the preview beside the current editor.
            // workspace.openTextDocument({ content, language }) creates an untitled document — that
            // works fine for the editor view, but markdown.showPreviewToSide requires a URI with a
            // .md extension or the markdown languageId so VS Code knows which renderer to use.
            // Using language:"markdown" on an untitled document satisfies both requirements.
            const doc = await workspace.openTextDocument({ content: markdown, language: "markdown" });
            // Show the raw source to give the user a way to copy or save it …
            const editor = await window.showTextDocument(doc, vscode.ViewColumn.Beside, /* preserveFocus */ true);
            void editor; // used only to ensure the doc is open before we show the preview
            // … then immediately open the rendered Markdown preview beside that source.
            await commands.executeCommand("markdown.showPreviewToSide", doc.uri);
          }
        );
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError("Schema Diff Markdown Preview failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      }
    })
  );

  /* COMMAND: generate a Knex migration file from two live connections */
  context.subscriptions.push(
    commands.registerCommand("firebird.schemaDiff.knexMigration", async () => {
      const { fetchProjectSnapshot } = await import("./database-projects");
      const { diffProjects } = await import("./database-projects/publish-model");
      const { CredentialStore } = await import("./shared/credential-store");

      const connections = context.globalState.get<{ [key: string]: import('./interfaces').ConnectionOptions }>(Constants.ConectionsKey);
      if (!connections || Object.keys(connections).length < 2) {
        logger.showError("You need at least two saved connections to generate a Knex migration.");
        return;
      }

      const items = Object.values(connections).map(c => ({
        label: c.embedded ? `[embedded] ${c.database}` : `${c.host}: ${c.database}`,
        detail: c.id,
        conn: c,
      }));

      const sourcePick = await window.showQuickPick(items, { placeHolder: "Select SOURCE database (the schema to migrate FROM)" });
      if (!sourcePick) { return; }

      const targetItems = items.filter(i => i.detail !== sourcePick.detail);
      const targetPick = await window.showQuickPick(targetItems, { placeHolder: "Select TARGET database (the schema to bring in line with source)" });
      if (!targetPick) { return; }

      const langPick = await window.showQuickPick(
        [
          { label: "JavaScript (.js)", description: "CommonJS — drop directly into migrations/", value: "js" as const },
          { label: "TypeScript (.ts)", description: "Uses import type { Knex } — for TS-based Knex projects", value: "ts" as const },
        ],
        { placeHolder: "Output language" }
      );
      if (!langPick) { return; }

      const includeDropsPick = await window.showQuickPick(
        [
          { label: "No", description: "Only additive/modifying changes (default, safer)" },
          { label: "Yes", description: "Also DROP objects present in target but not in source — DESTRUCTIVE" },
        ],
        { placeHolder: "Include DROP statements for objects only in the target database?" }
      );
      if (!includeDropsPick) { return; }

      try {
        await window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Generating Knex migration…", cancellable: false },
          async () => {
            const [sourcePassword, targetPassword] = await Promise.all([
              CredentialStore.getPassword(sourcePick.conn.id),
              CredentialStore.getPassword(targetPick.conn.id),
            ]);
            const src = { ...sourcePick.conn, password: sourcePassword ?? "" };
            const tgt = { ...targetPick.conn, password: targetPassword ?? "" };

            const [sourceSnapshot, targetSnapshot] = await Promise.all([
              fetchProjectSnapshot(src),
              fetchProjectSnapshot(tgt),
            ]);

            const diff = diffProjects(sourceSnapshot, targetSnapshot);
            const now = new Date();
            const migration = renderKnexMigration(diff, sourcePick.label, targetPick.label, {
              includeDrops: includeDropsPick.label === "Yes",
              language: langPick.value,
              generatedAt: now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
            });

            const lang = langPick.value === "ts" ? "typescript" : "javascript";
            const doc = await workspace.openTextDocument({ content: migration, language: lang });
            await window.showTextDocument(doc, vscode.ViewColumn.Beside);

            const ts = knexMigrationTimestamp(now);
            logger.showInfo(
              `Knex migration generated: ${sourcePick.label} → ${targetPick.label}. ` +
              `Save as migrations/${ts}_firebird_migration.${langPick.value} in your project. ` +
              `Review it carefully before running knex migrate:latest.`
            );
          }
        );
      } catch (err: any) {
        logger.error(err?.message ?? err);
        logger.showError("Knex migration generation failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      }
    })
  );

  /* COMMAND: generate a runnable migration script between two live connections (docs/roadmap/schema-diff-migration-script.md) */
  context.subscriptions.push(
    commands.registerCommand("firebird.schemaDiff.generateMigrationScript", () => {
      runGenerateMigrationScript(context).catch(err => {
        logger.error(err?.message ?? err);
        logger.showError("Generate Migration Script failed. Check logs for details.", ["Show Logs"]).then(sel => {
          if (sel === "Show Logs") { logger.showOutput(); }
        });
      });
    })
  );

  /* COMMAND: add bookmark */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.add", async () => {
      const editor = window.activeTextEditor;
      let sql = "";
      if (editor && editor.document.languageId === 'sql') {
        const sel = editor.selection;
        sql = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
      }
      if (!sql.trim()) {
        logger.showError("No SQL content to bookmark. Open or select a SQL query first.");
        return;
      }
      const name = await window.showInputBox({
        prompt: "Enter a name for this bookmark",
        placeHolder: "e.g. List active customers",
        validateInput: v => (v && v.trim() ? undefined : "Please enter a bookmark name."),
      });
      if (!name) { return; }
      await bookmarkProvider.add(name.trim(), sql);
      logger.showInfo(`Bookmark '${name.trim()}' saved.`);
    })
  );

  /* COMMAND: open bookmark in editor */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.open", async (item: BookmarkItem) => {
      if (!item?.bookmark?.sql) { return; }
      await Driver.createSQLTextDocument(item.bookmark.sql);
    })
  );

  /* COMMAND: delete bookmark */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.delete", async (item: BookmarkItem) => {
      if (!item?.bookmark) { return; }
      const confirm = await window.showWarningMessage(
        `Delete bookmark '${item.bookmark.name}'?`, { modal: true }, "Delete"
      );
      if (confirm === "Delete") {
        await bookmarkProvider.delete(item.bookmark.id);
      }
    })
  );

  /* COMMAND: rename bookmark */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.rename", async (item: BookmarkItem) => {
      if (!item?.bookmark) { return; }
      const newName = await window.showInputBox({
        prompt: "Enter new bookmark name",
        value: item.bookmark.name,
        validateInput: v => (v && v.trim() ? undefined : "Please enter a name."),
      });
      if (!newName) { return; }
      await bookmarkProvider.rename(item.bookmark.id, newName.trim());
    })
  );

  /* COMMAND: bind a bookmark to a Quick Query slot (docs/roadmap/quick-queries.md) */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.assignSlot", async (item: BookmarkItem) => {
      if (!item?.bookmark) { return; }
      const taken = new Map(
        bookmarkProvider.getAll()
          .filter(b => b.slot !== undefined && b.id !== item.bookmark.id)
          .map(b => [b.slot as number, b.name])
      );
      const picks: (QuickPickItem & { slot?: number })[] = [
        ...Array.from({ length: QUICK_QUERY_SLOT_COUNT }, (_unused, i) => {
          const slot = i + 1;
          const occupant = taken.get(slot);
          return {
            label: `Quick Query ${slot}`,
            // Naming who currently holds a slot matters: picking it silently unbinds them.
            description: occupant ? `currently: ${occupant} (will be unbound)` : undefined,
            picked: item.bookmark.slot === slot,
            slot,
          };
        }),
        { label: "Clear slot assignment", slot: undefined },
      ];
      const choice = await window.showQuickPick(picks, {
        title: `Assign '${item.bookmark.name}' to a Quick Query slot`,
        placeHolder: "Bind the slot's key combo in VS Code's Keyboard Shortcuts editor",
      });
      if (!choice) { return; }
      await bookmarkProvider.assignSlot(item.bookmark.id, choice.slot);
      logger.showInfo(
        choice.slot === undefined
          ? `'${item.bookmark.name}' is no longer bound to a Quick Query slot.`
          : `'${item.bookmark.name}' is now Quick Query ${choice.slot}. Bind a key to "Firebird: Run Quick Query ${choice.slot}" to use it.`
      );
    })
  );

  /* COMMAND: refresh bookmarks view */
  context.subscriptions.push(
    commands.registerCommand("firebird.bookmarks.refresh", () => {
      bookmarkProvider.refresh();
    })
  );

  /* COMMAND: clear finished (succeeded/failed) entries from the Background Tasks view */
  context.subscriptions.push(
    commands.registerCommand("firebird.tasks.clearCompleted", () => {
      taskTracker.clearCompleted();
    })
  );

  /* COMMAND: show explain plan for active SQL */
  context.subscriptions.push(
    commands.registerCommand("firebird.explainPlan", async () => {
      try {
        const plan = await Driver.getQueryPlan();
        const doc = await workspace.openTextDocument({ content: plan, language: "plaintext" });
        await window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch (err: any) {
        logger.error(err?.message ?? err);
        if (err?.notify) {
          logger.showError(err.message, err.options || []).then(sel => {
            if (sel === "New SQL Document") { commands.executeCommand("firebird.explorer.newSqlDocument"); }
            if (sel === "Set Active Database") { commands.executeCommand("firebird.chooseActive"); }
          });
        } else {
          logger.showError("Could not generate explain plan. Check logs for details.", ["Show Logs"]).then(sel => {
            if (sel === "Show Logs") { logger.showOutput(); }
          });
        }
      }
    })
  );

  /* COMMAND: show the graphical (diagram) query plan for the active SQL */
  context.subscriptions.push(
    commands.registerCommand("firebird.showEstimatedPlan", () => {
      // Capture the editor's SQL *before* the webview opens.
      //
      // The plan is fetched when the webview reports "ready", by which point the webview itself is
      // the active editor — `window.activeTextEditor` is undefined for a non-text editor — so
      // resolving the SQL then produced "No SQL document opened!" even with a .sql file right
      // there. Found by the Playwright tier (docs/roadmap/webview-ui-testing.md); it had been
      // written off as a test limitation before that.
      const editor = window.activeTextEditor;
      const sql = editor?.document.languageId === "sql"
        ? (editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection))
        : undefined;
      firebirdQueryPlanView.open(sql);
    })
  );

  /* COMMAND: open a history entry in the editor */
  context.subscriptions.push(
    commands.registerCommand("firebird.history.open", async (item: QueryHistoryItem) => {
      if (!item?.entry?.sql) { return; }
      await Driver.createSQLTextDocument(item.entry.sql);
    })
  );

  /* COMMAND: run a history entry directly, against the connection it originally ran on */
  context.subscriptions.push(
    commands.registerCommand("firebird.history.run", async (item: QueryHistoryItem) => {
      if (!item?.entry?.sql) { return; }

      let connectionOptions: ConnectionOptions | undefined;
      if (item.entry.connectionId) {
        const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
        const saved = connections?.[item.entry.connectionId];
        if (saved) {
          connectionOptions = { ...saved, password: (await CredentialStore.getPassword(saved.id)) ?? "" };
        } else {
          logger.showInfo("The connection this query originally ran on no longer exists. Running against the active database instead.");
        }
      }

      Driver.runBatch(item.entry.sql, connectionOptions)
        .then(batchResults => {
          // Driver.runBatch() already logged each statement to session history.
          const allMessages = batchResults.every(r => !r.rows && !r.error);
          if (allMessages && batchResults.length === 1 && batchResults[0].message) {
            logger.showInfo(batchResults[0].message);
            commands.executeCommand("firebird.explorer.refresh");
          } else {
            firebirdQueryResults.displayBatch(batchResults, config.recordsPerPage);
          }
        })
        .catch(err => {
          logger.error(err?.message ?? err);
          logger.showError("Query failed. Check logs for details.", ["Show Logs"]).then(sel => {
            if (sel === "Show Logs") { logger.showOutput(); }
          });
        });
    })
  );

  /* COMMAND: delete a single history entry */
  context.subscriptions.push(
    commands.registerCommand("firebird.history.delete", async (item: QueryHistoryItem) => {
      if (!item?.entry) { return; }
      await queryHistoryProvider.delete(item.entry.id);
    })
  );

  /* COMMAND: clear all history */
  context.subscriptions.push(
    commands.registerCommand("firebird.history.clear", async () => {
      const confirm = await window.showWarningMessage("Clear all query history?", { modal: true }, "Clear");
      if (confirm === "Clear") {
        await queryHistoryProvider.clear();
      }
    })
  );

  /* Generic "Script as Create" / "Script as Drop" — works regardless of the selected object's
     type (table/view/procedure/trigger/generator/domain/role/exception/user/index), since each
     node class implements scriptAsCreate()/scriptAsDrop() itself. */
  context.subscriptions.push(
    commands.registerCommand("firebird.scriptAsCreate", (node: any) => {
      if (typeof node?.scriptAsCreate !== "function") { return; }
      node.scriptAsCreate().catch((err: any) => logger.error(err?.message ?? err));
    })
  );
  context.subscriptions.push(
    commands.registerCommand("firebird.scriptAsDrop", (node: any) => {
      if (typeof node?.scriptAsDrop !== "function") { return; }
      node.scriptAsDrop().catch((err: any) => logger.error(err?.message ?? err));
    })
  );

  /* Generic "Show Object Privileges" — works for any node type implementing showPrivileges()
     (table/view/procedure/role), showing that object's grants in the results grid. */
  context.subscriptions.push(
    commands.registerCommand("firebird.showPrivileges", (node: any) => {
      if (typeof node?.showPrivileges !== "function") { return; }
      node
        .showPrivileges()
        .then((result: any) => {
          if (result) {
            firebirdQueryResults.display(result, config.recordsPerPage);
          }
        })
        .catch((err: any) => logger.error(err?.message ?? err));
    })
  );

  /* Object Explorer Filters — narrows a category folder's (Tables, Views, Procedures, ...)
     children to objects whose name contains a substring, distinct from Object Search's one-shot
     fuzzy lookup across every object type at once. */
  context.subscriptions.push(
    commands.registerCommand("firebird.folder.setFilter", (node: NodeCategoryFolder) => {
      node.setFilter().catch((err: any) => logger.error(err?.message ?? err));
    })
  );
  context.subscriptions.push(
    commands.registerCommand("firebird.folder.clearFilter", (node: NodeCategoryFolder) => {
      node.clearFilter().catch((err: any) => logger.error(err?.message ?? err));
    })
  );

  /* COMMAND: refresh history view */
  context.subscriptions.push(
    commands.registerCommand("firebird.history.refresh", () => {
      queryHistoryProvider.refresh();
    })
  );
}

export async function deactivate(): Promise<void> {
  await Driver.shutdown();
}


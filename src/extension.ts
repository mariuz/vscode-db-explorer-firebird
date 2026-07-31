import {ExtensionContext, window, commands, workspace} from "vscode";
import {Constants, getOptions} from "./config";
import {FirebirdTreeDataProvider} from "./firebirdTreeDataProvider";
import {NodeHost, NodeDatabase, NodeTable, NodeField, NodeView, NodeProcedure, NodeTrigger, NodeGenerator, NodeDomain, NodeRole, NodeException, NodeUser, NodeIndex, NodeIndexFolder, NodeCategoryFolder} from "./nodes";
import {Options, FirebirdTree, ConnectionOptions} from "./interfaces";
import {connectionPicker} from "./shared/connection-picker";
import {Driver} from "./shared/driver";
import * as vscode from 'vscode';
import {Global} from "./shared/global";
import {CredentialStore} from "./shared/credential-store";
import {logger} from "./logger/logger";
import {KeywordsDb} from "./language-server/db-words.provider";
import QueryResultsView, {AnalyzeResultsRequest, AnalyzePlanRequest, ViewTableDiagramRequest} from "./result-view";
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
import {SqlLinter} from "./shared/sql-linter";
import {BookmarkProvider, BookmarkItem} from "./bookmarks/bookmark-provider";
import {fetchSchemaSnapshot, diffSchemas, renderDiffReport} from "./schema-diff/schema-diff";
import {QueryHistoryProvider, QueryHistoryItem} from "./query-history/query-history-provider";
import {TaskTracker} from "./task-panel/task-tracker";
import {registerCopilotChatParticipant} from "./copilot/copilot-chat-participant";
import {registerAiQueryActions, runAnalyzeResultsAction, runAnalyzePlanAction} from "./copilot/ai-query-actions";
import {buildIsqlArgs, buildIsqlEnv, resolveIsqlExecutable} from "./shared/isql-terminal";
import {resolveGbakExecutable} from "./shared/gbak-options";
import {attemptConnection} from "./shared/connection-wizard";
import {getConnectionLabel} from "./shared/utils";
import {loadWorkspaceConnections} from "./shared/workspace-config";
import {registerSqlNotebook, FIREBIRD_NOTEBOOK_TYPE} from "./sql-notebook";
import {registerMcpServer, openMcpWriteAuditLog} from "./mcp-server";
import {listConnections, getActiveConnection} from "./connection-sharing";
import {runQuery, runWriteQuery} from "./connection-sharing/run-query";
import {editConnectionSharingPermissions} from "./connection-sharing/permissions";
import {runBuildProject, runPublishProject, runGenerateMigrationScript} from "./database-projects";
import {runContainerProvisionWizard} from "./container-provisioning";

/** Matches shared/row-edit.ts's assertValidIdentifier() — used for inline input-box validation before that throws. */
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

  /* Workspace-level connections (.vscode/firebird.json): auto-activate the one marked "default"
     (or the only one, if there's exactly one and nothing else is active yet), and keep the tree
     in sync whenever the file is created/edited/removed. */
  void activateDefaultWorkspaceConnection();
  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(() => {
      commands.executeCommand("firebird.explorer.refresh");
      void activateDefaultWorkspaceConnection();
    })
  );
  const firebirdJsonWatcher = workspace.createFileSystemWatcher("**/.vscode/firebird.json");
  context.subscriptions.push(firebirdJsonWatcher);
  context.subscriptions.push(
    firebirdJsonWatcher.onDidChange(() => commands.executeCommand("firebird.explorer.refresh")),
    firebirdJsonWatcher.onDidCreate(() => commands.executeCommand("firebird.explorer.refresh")),
    firebirdJsonWatcher.onDidDelete(() => commands.executeCommand("firebird.explorer.refresh"))
  );

  async function activateDefaultWorkspaceConnection(): Promise<void> {
    if (Global.activeConnection) { return; }
    const conns = await loadWorkspaceConnections();
    const chosen = conns.find(c => c.isDefault) ?? (conns.length === 1 ? conns[0] : undefined);
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
    })
  );

  /* DB ITEM: set/update the stored password for this connection */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.setPassword", (databaseNode: NodeDatabase) => {
      databaseNode.setPassword().catch(err => logger.error(err));
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
   * Shared implementation behind both "Run Firebird Query" and "Run Statement Under Cursor":
   * executes `sql` (or, when omitted, Driver.runBatch()'s own selection/whole-document default)
   * and routes the results the same way for both — a lone DDL/DML statement becomes an info
   * notification plus an explorer refresh, anything else goes to the results webview. Kept as one
   * function so the two commands can't drift apart on the DDL/refresh handling or on the
   * notify-vs-generic error branches, as they previously had.
   */
  const runSqlBatch = (sql?: string) => {
    Driver.runBatch(sql)
      .then(batchResults => {
        // Driver.runBatch() already logged each statement to session history
        // via the historyLogger registered above.

        // If every result is a DDL/DML message (no row data), show notification
        const allMessages = batchResults.every(r => !r.rows && !r.error);
        if (allMessages && batchResults.length === 1 && batchResults[0].message) {
          logger.info(batchResults[0].message);
          logger.showInfo(batchResults[0].message);
          commands.executeCommand("firebird.explorer.refresh");
        } else {
          firebirdQueryResults.displayBatch(batchResults, config.recordsPerPage);
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
      if (editor.selection.isEmpty) {
        const offset = editor.document.offsetAt(editor.selection.active);
        const statement = splitStatementsWithOffsets(editor.document.getText())
          .find(range => offset >= range.start && offset <= range.end);
        sql = statement?.text;
      }

      runSqlBatch(sql);
    })
  );

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
        firebirdQueryResults.display(result, config.recordsPerPage, tableNode.getTableName());
      });
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
        firebirdQueryResults.display(result, config.recordsPerPage, fieldNode.getTableName());
      });
    })
  );

  /* COMMAND view node: select all view records */
  context.subscriptions.push(
    commands.registerCommand("firebird.selectAllViewRecords", (viewNode: NodeView) => {
      viewNode.selectAllRecords().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage, viewNode.getViewName());
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

  /* DB: monitor active connections — opens the Live Profiler */
  context.subscriptions.push(
    commands.registerCommand("firebird.database.monitorDatabase", (databaseNode: NodeDatabase) => {
      databaseNode.monitorDatabase(firebirdProfilerView).catch(err => {
        logger.error(err.message ?? err);
        logger.showError("Could not open the Live Profiler. Check logs for details.", ["Show Log Output"]).then(sel => {
          if (sel === "Show Log Output") { logger.showOutput(); }
        });
      });
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
    commands.registerCommand("firebird.database.searchObjects", (databaseNode: NodeDatabase) => {
      databaseNode.searchObjects(firebirdQueryResults).catch(err => {
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
    commands.registerCommand("firebird.schemaVisualizer.open", (databaseNode: NodeDatabase) => {
      databaseNode.openSchemaDesigner(firebirdSchemaDesigner);
    })
  );

  /* isql/isql-fb terminal integration (similar to "psql in the terminal" in Microsoft's
     PostgreSQL extension for VS Code) */

  /**
   * Unlike isql's own `-z` (exits cleanly), gbak's `-z` always exits non-zero -- confirmed
   * directly against a real gbak (Firebird 6.0): it still prints its version banner to stdout
   * ("gbak:gbak version ...") first, then errors with "requires both input and output filenames"
   * since `-z` alone isn't a full backup/restore command. Checking the exit code the way
   * checkIsqlExecutable() does would incorrectly report a real, working gbak as "not found" --
   * check for the version banner in stdout instead.
   */
  function checkGbakExecutable(candidate: string): Promise<boolean> {
    return new Promise(resolve => {
      try {
        const child = cp.execFile(candidate, ["-z"], {timeout: 3000}, (_err, stdout) => {
          resolve((stdout || "").toLowerCase().includes("gbak version"));
        });
        child.on("error", () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  function checkIsqlExecutable(candidate: string): Promise<boolean> {
    return new Promise(resolve => {
      try {
        const child = cp.execFile(candidate, ["-z"], {timeout: 3000}, err => resolve(!err));
        child.on("error", () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  async function launchIsqlTask(connectionOptions: ConnectionOptions, taskName: string, extraArgs: string[] = []): Promise<void> {
    if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
      logger.showError("Open a workspace folder to use isql in the integrated terminal.");
      return;
    }

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

    const task = new vscode.Task(
      {type: "firebird-isql"},
      workspace.workspaceFolders[0],
      taskName,
      "Firebird",
      new vscode.ShellExecution(executable, buildIsqlArgs(connectionOptions, extraArgs), {env: buildIsqlEnv(connectionOptions)})
    );
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: false};
    await vscode.tasks.executeTask(task);
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
        await launchIsqlTask(dbDetails, `ISQL: ${fileName}`, ["-i", editor.document.fileName]);
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
      firebirdQueryPlanView.open();
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


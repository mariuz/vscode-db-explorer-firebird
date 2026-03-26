import {ExtensionContext, window, commands, workspace} from "vscode";
import {Constants, getOptions} from "./config";
import {FirebirdTreeDataProvider} from "./firebirdTreeDataProvider";
import {NodeHost, NodeDatabase, NodeTable, NodeField, NodeView} from "./nodes";
import {Options, FirebirdTree} from "./interfaces";
import {connectionPicker} from "./shared/connection-picker";
import {Driver} from "./shared/driver";
import * as vscode from 'vscode';
import {Global} from "./shared/global";
import {CredentialStore} from "./shared/credential-store";
import {logger} from "./logger/logger";
import {KeywordsDb} from "./language-server/db-words.provider";
import QueryResultsView from "./result-view";
import MockData from "./mock-data/mock-data";
import LanguageServer from "./language-server";
import * as cp from 'node:child_process';
import {formatSQL} from "./shared/sql-formatter";
import {SqlLinter} from "./shared/sql-linter";
import {BookmarkProvider, BookmarkItem} from "./bookmarks/bookmark-provider";
import {fetchSchemaSnapshot, diffSchemas, renderDiffReport} from "./schema-diff/schema-diff";


export function activate(context: ExtensionContext) {
  logger.info(`Activating extension ...`);

  /* initialise credential store with extension context for SecretStorage access */
  CredentialStore.setContext(context);

  /* load configuration and reload every time it's changed */
  logger.info(`Loading configuration...`);
  let config: Options = getOptions();
  Driver.setClient(config.useNativeDriver, context);
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(() => {
      logger.debug("Configuration changed. Reloading configuration...");
      config = getOptions();
      Driver.setClient(config.useNativeDriver, context);
      commands.executeCommand("firebird.explorer.refresh");
    })
  );

  /* initialize providers */
  const firebirdLanguageServer = new LanguageServer();
  const firebirdDatabaseWords = new KeywordsDb();
  const firebirdTreeDataProvider = new FirebirdTreeDataProvider(context);
  const firebirdMockData = new MockData(context.extensionPath);
  const firebirdQueryResults = new QueryResultsView(context.extensionPath);

  /* SQL linter */
  const sqlLinter = new SqlLinter();
  sqlLinter.setSchemaProvider(() => firebirdDatabaseWords.getSchema());
  sqlLinter.activate(context);

  /* Bookmarks */
  const bookmarkProvider = new BookmarkProvider(context);

  context.subscriptions.push(
    window.registerTreeDataProvider(Constants.FirebirdExplorerViewId, firebirdTreeDataProvider),
    window.registerTreeDataProvider("firebird-bookmarks", bookmarkProvider),
    firebirdMockData,
    firebirdQueryResults,
    firebirdLanguageServer,
    sqlLinter,
    bookmarkProvider
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

  /* DB ITEM: choose active database */
  context.subscriptions.push(
    commands.registerCommand("firebird.chooseActive", () => {
      connectionPicker(context)
        .then(pickedConnection => {
          if (pickedConnection) {
            const id: string = pickedConnection.detail.split(": ").pop();
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

  /* COMMAND: run document query */
  context.subscriptions.push(
    commands.registerCommand("firebird.runQuery", () => {
      Driver.runQuery()
        .then(res => {
          if (res[0] && "message" in res[0]) {
            logger.info(res[0].message);
            logger.showInfo(res[0].message);
            commands.executeCommand("firebird.explorer.refresh");
          } else {
            firebirdQueryResults.display(res, config.recordsPerPage);
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
        firebirdQueryResults.display(result, config.recordsPerPage);
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
        firebirdQueryResults.display(result, config.recordsPerPage);
      });
    })
  );

  /* COMMAND view node: select all view records */
  context.subscriptions.push(
    commands.registerCommand("firebird.selectAllViewRecords", (viewNode: NodeView) => {
      viewNode.selectAllRecords().then(result => {
        firebirdQueryResults.display(result, config.recordsPerPage);
      });
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
        child.stdout.on('data', (data) => {
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
}


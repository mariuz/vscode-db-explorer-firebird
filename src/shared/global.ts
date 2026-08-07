import { StatusBarItem, StatusBarAlignment, ThemeColor, window, commands, ExtensionContext, workspace } from "vscode";
import { loadWorkspaceConnections } from "./workspace-config";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { CredentialStore } from "./credential-store";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "./utils";
import { themeColorIdFor } from "./connection-color";
import { isConnectionLostError, isConnectionUnreachable, markConnectionUnreachable, markConnectionReachable } from "./connection-health";

export class Global {
  private static _globalActiveConnection: ConnectionOptions | undefined;
  private static editorConnections = new Map<string, ConnectionOptions | null>();
  private static firebirdStatusBarItem: StatusBarItem;
  public static context: ExtensionContext;

  public static getActiveUri(): string | undefined {
    try {
      const activeNotebook = (window as any).activeNotebookEditor;
      if (activeNotebook && activeNotebook.notebookUri) {
        return activeNotebook.notebookUri.toString();
      }
      const activeText = window.activeTextEditor;
      if (activeText) {
        if (activeText.document.uri.scheme === 'vscode-notebook-cell') {
          const notebook = (workspace as any).notebookDocuments?.find((nb: any) =>
            nb.getCells?.().some((cell: any) => cell.document.uri.toString() === activeText.document.uri.toString())
          );
          if (notebook && notebook.uri) {
            return notebook.uri.toString();
          }
        }
        return activeText.document.uri.toString();
      }
    } catch (e) {
      // ignore
    }
    return undefined;
  }

  public static hasEditorConnection(uri: string): boolean {
    return this.editorConnections.has(uri);
  }

  public static setEditorConnection(uri: string, conn: ConnectionOptions | null): void {
    this.editorConnections.set(uri, conn);
  }

  public static removeEditorConnection(uri: string): void {
    this.editorConnections.delete(uri);
  }

  static get activeConnection(): ConnectionOptions | undefined {
    const activeUri = this.getActiveUri();
    if (activeUri) {
      if (this.editorConnections.has(activeUri)) {
        const val = this.editorConnections.get(activeUri);
        return val === null ? undefined : val;
      }
    }
    return this._globalActiveConnection;
  }

  static set activeConnection(newActiveConnection: ConnectionOptions | undefined) {
    const activeUri = this.getActiveUri();
    if (activeUri && newActiveConnection) {
      this.editorConnections.set(activeUri, newActiveConnection);
      try {
        const { syncNotebookConnection } = require("../sql-notebook/controller");
        syncNotebookConnection(activeUri, newActiveConnection);
      } catch (e) {
        // ignore
      }
    }
    const isNew = !this._globalActiveConnection || this._globalActiveConnection.id !== newActiveConnection?.id;
    if (isNew && newActiveConnection) {
      this._globalActiveConnection = newActiveConnection;
      logger.showInfo(this.getActiveDbNotifText(newActiveConnection));
      if (newActiveConnection.id) {
        void this.addToRecent(newActiveConnection.id);
      }
    } else if (!newActiveConnection) {
      this._globalActiveConnection = undefined;
    }
    if (newActiveConnection) {
      this.updateStatusBarItems(newActiveConnection);
    } else {
      this.clearStatusBarItem();
    }
  }

  private static async addToRecent(id: string): Promise<void> {
    if (!id || !this.context) { return; }
    const key = Constants.RecentConnectionsKey;
    let recent = this.context.globalState.get<string[]>(key, []);
    recent = recent.filter(r => r !== id);
    recent.unshift(id);
    const maxRecent = workspace.getConfiguration("firebird").get<number>("maxRecentConnections", 5);
    if (recent.length > maxRecent) {
      recent = recent.slice(0, maxRecent);
    }
    await this.context.globalState.update(key, recent);
  }

  public static patchActiveConnection(patch: Partial<ConnectionOptions>): void {
    const active = this.activeConnection;
    if (active) {
      const updated = { ...active, ...patch };
      const activeUri = this.getActiveUri();
      if (activeUri) {
        this.editorConnections.set(activeUri, updated);
      }
      if (this._globalActiveConnection?.id === active.id) {
        this._globalActiveConnection = { ...this._globalActiveConnection, ...patch };
      }
      this.updateStatusBarItems(updated);
    } else if (this._globalActiveConnection) {
      this._globalActiveConnection = { ...this._globalActiveConnection, ...patch };
      this.updateStatusBarItems(this._globalActiveConnection);
    }
  }

  public static async getConnectionById(id: string): Promise<ConnectionOptions | undefined> {
    if (!this.context) { return undefined; }
    const connections = this.context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
    if (connections[id]) {
      const conn = { ...connections[id] };
      conn.password = (await CredentialStore.getPassword(id)) ?? "";
      return conn;
    }
    const workspaceConnections = await loadWorkspaceConnections();
    const workspaceFound = workspaceConnections.find(c => c.id === id);
    if (workspaceFound) {
      return { ...workspaceFound };
    }
    return undefined;
  }

  public static async setActiveConnectionById(context: ExtensionContext, id: string): Promise<void> {
    const conn = await this.getConnectionById(id);
    if (conn) {
      this.activeConnection = conn;
    }
  }

  public static initStatusBarItems(): void {
    if (!this.firebirdStatusBarItem) {
      this.firebirdStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
      this.firebirdStatusBarItem.text = "FIREBIRD: No active database.";
      this.firebirdStatusBarItem.tooltip = "Firebird: No active database. Click to set active database.";
      this.firebirdStatusBarItem.command = "firebird.chooseActive";
      this.firebirdStatusBarItem.show();
    }
  }

  public static updateStatusBarItems(activeConnection: ConnectionOptions): void {
    if (!this.firebirdStatusBarItem) {
      this.firebirdStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
      this.firebirdStatusBarItem.show();
    }
    if (isConnectionUnreachable(activeConnection.id)) {
      const dbName = getDatabaseFileName(activeConnection.database);
      this.firebirdStatusBarItem.text = `$(debug-disconnect) FIREBIRD: ${dbName} (connection lost)`;
      this.firebirdStatusBarItem.tooltip = `Firebird: Lost connection to ${dbName}. Click to reconnect.`;
      this.firebirdStatusBarItem.color = new ThemeColor("statusBarItem.warningForeground");
      this.firebirdStatusBarItem.backgroundColor = new ThemeColor("statusBarItem.warningBackground");
      this.firebirdStatusBarItem.command = "firebird.reconnectActive";
      return;
    }
    this.firebirdStatusBarItem.text = this.getStatusBarItemText(activeConnection);
    this.firebirdStatusBarItem.tooltip = this.getStatusBarTooltipText(activeConnection);
    const colorId = themeColorIdFor(activeConnection.color);
    this.firebirdStatusBarItem.color = colorId ? new ThemeColor(colorId) : undefined;
    this.firebirdStatusBarItem.backgroundColor = undefined;
    this.firebirdStatusBarItem.command = "firebird.chooseActive";
  }

  public static clearStatusBarItem(): void {
    if (this.firebirdStatusBarItem) {
      this.firebirdStatusBarItem.text = "FIREBIRD: No active database.";
      this.firebirdStatusBarItem.tooltip = "Firebird: No active database. Click to set active database.";
      this.firebirdStatusBarItem.color = undefined;
      this.firebirdStatusBarItem.backgroundColor = undefined;
      this.firebirdStatusBarItem.command = "firebird.chooseActive";
    }
  }

  /**
   * Called when the active text editor changes — refreshes the status bar to show whichever
   * connection is bound to the newly focused editor (or the global fallback if none is bound).
   */
  public static refreshStatusBarForActiveEditor(): void {
    const conn = this.activeConnection;
    if (conn) {
      this.updateStatusBarItems(conn);
    } else {
      this.clearStatusBarItem();
    }
  }

  /**
   * Single entry point for both the SQL-execution path (Driver.runQuery()/runBatch()) and the
   * tree-expansion path (NodeCategoryFolder.getChildren()) to report a query outcome for a given
   * connection id — updates the shared unreachable registry (connection-health.ts) and, only when
   * that actually changes something, refreshes the status bar (if it's the active connection) and
   * the tree (so a NodeDatabase badge picks up the new state). A `err` that doesn't look like a
   * dropped connection (e.g. an ordinary SQL syntax error) is a no-op either way — see
   * isConnectionLostError()'s own doc comment for why message-shape, not just presence of an
   * error, is what matters here.
   */
  public static reportConnectionOutcome(connectionId: string | undefined, err: unknown): void {
    if (!connectionId) { return; }
    const changed = err
      ? (isConnectionLostError(err) && markConnectionUnreachable(connectionId))
      : markConnectionReachable(connectionId);
    if (!changed) { return; }

    if (this._globalActiveConnection?.id === connectionId) {
      this.updateStatusBarItems(this._globalActiveConnection);
    }
    const current = this.activeConnection;
    if (current?.id === connectionId) {
      this.updateStatusBarItems(current);
    }
    commands.executeCommand("firebird.explorer.refresh");
  }

  private static getStatusBarItemText(activeConnection: ConnectionOptions): string {
    const dbName = getDatabaseFileName(activeConnection.database);
    if (activeConnection.embedded) {
      return `FIREBIRD: $(file-directory) [embedded] $(database) ${dbName}`;
    }
    return `FIREBIRD: $(server) ${activeConnection.host} $(database) ${dbName}`;
  }

  private static getStatusBarTooltipText(activeConnection: ConnectionOptions): string {
    const dbName = getDatabaseFileName(activeConnection.database);
    if (activeConnection.embedded) {
      return `FIREBIRD: Using embedded database ${dbName}`;
    }
    return `FIREBIRD: Using ${dbName} database on host ${activeConnection.host}`;
  }

  private static getActiveDbNotifText(newActiveConnection: ConnectionOptions): string {
    const dbName = getDatabaseFileName(newActiveConnection.database);
    if (newActiveConnection.embedded) {
      return `Active connection: [embedded] ${dbName}`;
    }
    return `Active connection: ${newActiveConnection.host}:${dbName}`;
  }
}

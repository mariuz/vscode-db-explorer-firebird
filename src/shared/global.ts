import { StatusBarItem, StatusBarAlignment, ThemeColor, window, commands, ExtensionContext, workspace } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { CredentialStore } from "./credential-store";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "./utils";
import { themeColorIdFor } from "./connection-color";
import { isConnectionLostError, isConnectionUnreachable, markConnectionUnreachable, markConnectionReachable } from "./connection-health";

export class Global {
  private static _activeConnection: ConnectionOptions;
  private static firebirdStatusBarItem: StatusBarItem;
  public static context: ExtensionContext;

  static get activeConnection(): ConnectionOptions {
    return this._activeConnection;
  }

  static set activeConnection(newActiveConnection: ConnectionOptions) {
    const isNew = !this._activeConnection || this._activeConnection.id !== newActiveConnection.id;
    if (isNew) {
      this._activeConnection = newActiveConnection;
      this.updateStatusBarItems(newActiveConnection);
      logger.showInfo(this.getActiveDbNotifText(newActiveConnection));
      if (newActiveConnection.id) {
        void this.addToRecent(newActiveConnection.id);
      }
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

  /**
   * Patches fields (color, group, a renamed database path, ...) on the currently active
   * connection in place and refreshes the status bar — distinct from the `activeConnection`
   * setter above, which only reacts to the active connection's *identity* changing (a different
   * `id`) and is a no-op for same-id field edits like these.
   */
  public static patchActiveConnection(patch: Partial<ConnectionOptions>): void {
    if (!this._activeConnection) { return; }
    this._activeConnection = { ...this._activeConnection, ...patch };
    this.updateStatusBarItems(this._activeConnection);
  }

  public static async setActiveConnectionById(context: ExtensionContext, id: string): Promise<void> {
    const connections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
    if (!connections) { return; }
    if (Object.keys(connections).indexOf(id) > -1) {
      const conn = { ...connections[id] };
      /* populate password from SecretStorage so queries work immediately */
      conn.password = (await CredentialStore.getPassword(id)) ?? "";
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

    if (this._activeConnection?.id === connectionId) {
      this.updateStatusBarItems(this._activeConnection);
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

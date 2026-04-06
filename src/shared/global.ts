import { StatusBarItem, StatusBarAlignment, window, ExtensionContext } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { CredentialStore } from "./credential-store";
import { logger } from "../logger/logger";

export class Global {
  private static _activeConnection: ConnectionOptions;
  private static firebirdStatusBarItem: StatusBarItem;

  static get activeConnection(): ConnectionOptions {
    return this._activeConnection;
  }

  static set activeConnection(newActiveConnection: ConnectionOptions) {
    if (!this._activeConnection) {
      this._activeConnection = newActiveConnection;
      this.updateStatusBarItems(newActiveConnection);
      logger.showInfo(this.getActiveDbNotifText(newActiveConnection));
    } else {
      if (this._activeConnection.id !== newActiveConnection.id) {
        this._activeConnection = newActiveConnection;
        this.updateStatusBarItems(newActiveConnection);
        logger.showInfo(this.getActiveDbNotifText(newActiveConnection));
      }
    }
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
    if (this.firebirdStatusBarItem) {
      this.firebirdStatusBarItem.text = this.getStatusBarItemText(activeConnection);
      this.firebirdStatusBarItem.tooltip = this.getStatusBarTooltipText(activeConnection);
    } else {
      this.firebirdStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
      this.firebirdStatusBarItem.text = this.getStatusBarItemText(activeConnection);
      this.firebirdStatusBarItem.tooltip = this.getStatusBarTooltipText(activeConnection);
      this.firebirdStatusBarItem.show();
    }
  }

  private static getStatusBarItemText(activeConnection: ConnectionOptions): string {
    const dbName = (activeConnection.database.split("\\").pop() ?? activeConnection.database).split("/").pop() ?? activeConnection.database;
    if (activeConnection.embedded) {
      return `FIREBIRD: $(file-directory) [embedded] $(database) ${dbName}`;
    }
    return `FIREBIRD: $(server) ${activeConnection.host} $(database) ${dbName}`;
  }

  private static getStatusBarTooltipText(activeConnection: ConnectionOptions): string {
    const dbName = (activeConnection.database.split("\\").pop() ?? activeConnection.database).split("/").pop() ?? activeConnection.database;
    if (activeConnection.embedded) {
      return `FIREBIRD: Using embedded database ${dbName}`;
    }
    return `FIREBIRD: Using ${dbName} database on host ${activeConnection.host}`;
  }

  private static getActiveDbNotifText(newActiveConnection: ConnectionOptions): string {
    const dbName = (newActiveConnection.database.split("\\").pop() ?? newActiveConnection.database).split("/").pop() ?? newActiveConnection.database;
    if (newActiveConnection.embedded) {
      return `Active connection: [embedded] ${dbName}`;
    }
    return `Active connection: ${newActiveConnection.host}:${dbName}`;
  }
}

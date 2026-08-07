import { TreeDataProvider, TreeDragAndDropController, EventEmitter, Event, ExtensionContext, TreeItem, DataTransfer, DataTransferItem, CancellationToken } from "vscode";
import { v1  as uuidv1 } from "uuid";
import { NodeHost } from "./nodes";
import { ConnectionOptions, FirebirdTree } from "./interfaces";
import { connectionWizard } from "./shared/connection-wizard";
import { Constants } from "./config/constants";
import { Global } from "./shared/global";
import { CredentialStore } from "./shared/credential-store";
import { Driver } from "./shared/driver";
import { loadWorkspaceConnections } from "./shared/workspace-config";
import { logger } from "./logger/logger";
import { quoteIdentifierIfNeeded } from "./shared/identifier-quoting";

export class FirebirdTreeDataProvider implements TreeDataProvider<FirebirdTree>, TreeDragAndDropController<FirebirdTree> {
  public _onDidChangeTreeData: EventEmitter<FirebirdTree | undefined> = new EventEmitter<FirebirdTree | undefined>();
  public readonly onDidChangeTreeData: Event<FirebirdTree | undefined> = this._onDidChangeTreeData.event;

  public savedConnections: { [key: string]: ConnectionOptions } = {};

  constructor(private context: ExtensionContext) {}

  // Drag Object Explorer Entity into Editor (docs/roadmap/drag-identifier-into-editor.md) — drag
  // only, no drop target support, so dropMimeTypes stays empty and handleDrop() is never called.
  public readonly dropMimeTypes: readonly string[] = [];
  public readonly dragMimeTypes: readonly string[] = ["text/plain"];

  public handleDrag(source: readonly FirebirdTree[], dataTransfer: DataTransfer, _token: CancellationToken): void {
    const identifiers = source
      .map(node => node.getDragIdentifier?.())
      .filter((name): name is string => !!name)
      .map(name => quoteIdentifierIfNeeded(name));
    if (identifiers.length === 0) {
      return;
    }
    dataTransfer.set("text/plain", new DataTransferItem(identifiers.join(", ")));
  }

  public getTreeItem(element: FirebirdTree): Promise<TreeItem> | TreeItem {
    return element.getTreeItem(this.context);
  }

  public getChildren(element?: FirebirdTree): Thenable<FirebirdTree[]> | FirebirdTree[] {
    if (!element) {
      return this.getHostNodes();
    }
    return element.getChildren();
  }

  /* add new Firebird connection */
  public async addConnection() {
    logger.info("Add Connection start...");

    /* present connection wizard */
    await connectionWizard()
      .then(async newOptions => {
        await this.saveNewConnection(newOptions);
        logger.showInfo("New Firebird connection added successfully!");
      })
      .catch(error => {
        logger.error(error);
      });
  }

  /* create a brand-new database file, then save it as a connection the same way addConnection() does */
  public async createDatabase() {
    logger.info("Create Database start...");

    await connectionWizard("FIREBIRD: Create New Database")
      .then(async newOptions => {
        await Driver.createDatabase(newOptions);
        await this.saveNewConnection(newOptions);
        logger.showInfo("New Firebird database created successfully!");
      })
      .catch(error => {
        logger.error(error);
        logger.showError(`Could not create the database: ${error?.message ?? error}`);
      });
  }

  /**
   * Saves an already-fully-specified ConnectionOptions (e.g. one this extension just provisioned
   * itself, such as a freshly created Docker container) as a connection, without running the
   * interactive wizard — everything needed is already known.
   */
  public async addKnownConnection(newOptions: ConnectionOptions): Promise<void> {
    await this.saveNewConnection(newOptions);
  }

  /**
   * Persists a freshly-collected ConnectionOptions (from the wizard) as a saved connection:
   * generates its id, stores the password in SecretStorage (never in globalState), writes the
   * rest to globalState, sets it active, and refreshes the tree. Shared by addConnection() and
   * createDatabase() — the only difference between them is what happens before this point
   * (nothing, vs. actually creating the database file).
   */
  private async saveNewConnection(newOptions: ConnectionOptions): Promise<void> {
    const id = uuidv1();

    this.savedConnections = this.context.globalState.get<{ [key: string]: ConnectionOptions }>(
      Constants.ConectionsKey
    ) ?? {};
    logger.debug(`${Object.keys(this.savedConnections).length} saved connection(s) found...`);

    newOptions.id = id;
    if (typeof newOptions.port === "string") {
      newOptions.port = Number.parseInt(newOptions.port);
    }

    const password = newOptions.password;
    await CredentialStore.storePassword(id, password || "");

    if (newOptions.sshTunnel) {
      await CredentialStore.storeSshPassword(id, newOptions.sshTunnelPassword || "");
    }
    const optionsToSave: ConnectionOptions = { ...newOptions, password: undefined, sshTunnelPassword: undefined };

    this.savedConnections[id] = optionsToSave;

    await this.context.globalState.update(Constants.ConectionsKey, this.savedConnections);
    Global.activeConnection = newOptions;
    this.refresh();
    logger.debug(`Connection ID: ${this.savedConnections[id].id}`);
  }

  private async getHostNodes(): Promise<NodeHost[]> {
    logger.debug("Get host nodes start.");
    const connections = { ...(this.context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {}) };

    /* merge in connections declared by any open workspace folder's .vscode/firebird.json —
       re-read from disk on every refresh, never persisted into globalState */
    const workspaceConnections = await loadWorkspaceConnections();
    workspaceConnections.forEach(conn => { connections[conn.id] = conn; });

    const nodeHosts = [];
    if (Object.keys(connections).length > 0) {
      const groupedConnections = this.groupedArray(connections);

      for (const key in groupedConnections) {
        nodeHosts.push(new NodeHost(key, groupedConnections[key]));
      }
    }
    Global.initStatusBarItems();
    logger.debug("Get host nodes end.");
    return nodeHosts;
  }

  private groupedArray(connections: { [key: string]: ConnectionOptions }): { [host: string]: ConnectionOptions[] } {
    return Object.keys(connections)
      .map(id => {
        connections[id].id = id;
        return connections[id];
      })
      .reduce<{ [host: string]: ConnectionOptions[] }>((h, a) => {
        // An explicit group name (set via "Set Connection Group...") takes precedence over the
        // default host-based grouping, letting connections be organized by environment
        // ("Production", "Staging"...) instead of by where they happen to be hosted.
        const groupKey = a.group || (a.embedded ? "(embedded)" : a.host);
        return Object.assign(h, { [groupKey]: (h[groupKey] || []).concat(a) });
      }, {});
  }

  public refresh(element?: FirebirdTree): void {
    logger.debug("Refresh Firebird Explorer View");
    this._onDidChangeTreeData.fire(element);
  }
}

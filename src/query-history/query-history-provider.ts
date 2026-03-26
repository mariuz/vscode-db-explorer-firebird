import * as vscode from "vscode";

const HISTORY_KEY = "firebird.queryHistory";
const MAX_HISTORY = 50;

export interface HistoryEntry {
  id: string;
  sql: string;
  executedAt: string; // ISO date string
  rowCount?: number;
  durationMs?: number;
  error?: string;
}

export class QueryHistoryItem extends vscode.TreeItem {
  constructor(public readonly entry: HistoryEntry) {
    super(QueryHistoryItem.label(entry), vscode.TreeItemCollapsibleState.None);
    this.tooltip = entry.sql;
    this.description = QueryHistoryItem.description(entry);
    this.contextValue = "historyEntry";
    this.command = {
      command: "firebird.history.open",
      title: "Open Query",
      arguments: [this],
    };
  }

  private static label(entry: HistoryEntry): string {
    const single = entry.sql.replace(/\s+/g, " ").trim();
    return single.length > 60 ? single.slice(0, 57) + "..." : single;
  }

  private static description(entry: HistoryEntry): string {
    const date = new Date(entry.executedAt);
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (entry.error) {
      return `${time} — error`;
    }
    const rows = entry.rowCount !== undefined ? ` — ${entry.rowCount} row(s)` : "";
    return `${time}${rows}`;
  }
}

export class QueryHistoryProvider
  implements vscode.TreeDataProvider<QueryHistoryItem>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<QueryHistoryItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getTreeItem(element: QueryHistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(): QueryHistoryItem[] {
    const entries = this.getEntries();
    return entries.map(e => new QueryHistoryItem(e));
  }

  /** Returns all stored entries (most-recent first). */
  getEntries(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY) ?? [];
  }

  /** Adds an entry to the front of the history. */
  async add(entry: Omit<HistoryEntry, "id" | "executedAt">): Promise<void> {
    const entries = this.getEntries();
    const newEntry: HistoryEntry = {
      id: Date.now().toString(),
      executedAt: new Date().toISOString(),
      ...entry,
    };
    const updated = [newEntry, ...entries].slice(0, MAX_HISTORY);
    await this.context.globalState.update(HISTORY_KEY, updated);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Removes a single entry by id. */
  async delete(id: string): Promise<void> {
    const entries = this.getEntries().filter(e => e.id !== id);
    await this.context.globalState.update(HISTORY_KEY, entries);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Clears all history entries. */
  async clear(): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, []);
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

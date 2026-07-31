import * as vscode from 'vscode';
import { v1 as uuidv1 } from 'uuid';

const BOOKMARKS_KEY = 'firebird.bookmarks';

/** A saved SQL query bookmark */
export interface Bookmark {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
  /**
   * Quick Query slot this bookmark is bound to (1-based), if any — see
   * docs/roadmap/quick-queries.md. Undefined for the (normal) unbound case; a `firebird.quickQueries`
   * setting entry for the same slot takes precedence over this.
   */
  slot?: number;
}

/** A tree item representing a single bookmark */
export class BookmarkItem extends vscode.TreeItem {
  constructor(public readonly bookmark: Bookmark) {
    super(bookmark.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = bookmark.sql.length > 200 ? bookmark.sql.slice(0, 200) + '…' : bookmark.sql;
    const created = new Date(bookmark.createdAt).toLocaleDateString();
    this.description = bookmark.slot ? `Quick Query ${bookmark.slot} · ${created}` : created;
    this.contextValue = 'bookmark';
    this.command = {
      command: 'firebird.bookmarks.open',
      title: 'Open Bookmark',
      arguments: [this],
    };
    this.iconPath = new vscode.ThemeIcon('bookmark');
  }
}

/** A tree item representing the empty-state placeholder */
class EmptyBookmarkItem extends vscode.TreeItem {
  constructor() {
    super('No bookmarks saved yet.', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'empty';
  }
}

/** TreeDataProvider for the Bookmarks explorer view */
export class BookmarkProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const bookmarks = this.getAll();
    if (bookmarks.length === 0) {
      return [new EmptyBookmarkItem()];
    }
    return bookmarks.map(b => new BookmarkItem(b));
  }

  /** Return all saved bookmarks */
  getAll(): Bookmark[] {
    return this.context.globalState.get<Bookmark[]>(BOOKMARKS_KEY, []);
  }

  /** Add a new bookmark with the given name and SQL */
  async add(name: string, sql: string): Promise<void> {
    const bookmarks = this.getAll();
    const bookmark: Bookmark = {
      id: uuidv1(),
      name,
      sql,
      createdAt: new Date().toISOString(),
    };
    bookmarks.push(bookmark);
    await this.context.globalState.update(BOOKMARKS_KEY, bookmarks);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Delete a bookmark by id */
  async delete(id: string): Promise<void> {
    const bookmarks = this.getAll().filter(b => b.id !== id);
    await this.context.globalState.update(BOOKMARKS_KEY, bookmarks);
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Bind a bookmark to a Quick Query slot, or clear its binding with `undefined`
   * (docs/roadmap/quick-queries.md). Any *other* bookmark holding that slot is cleared first — a
   * slot is one keybinding, so two bookmarks claiming it would make which one runs depend on
   * insertion order.
   */
  async assignSlot(id: string, slot: number | undefined): Promise<void> {
    const bookmarks = this.getAll().map(b => {
      if (b.id === id) {
        const { slot: _previous, ...rest } = b;
        return slot === undefined ? rest : { ...rest, slot };
      }
      if (slot !== undefined && b.slot === slot) {
        const { slot: _taken, ...rest } = b;
        return rest;
      }
      return b;
    });
    await this.context.globalState.update(BOOKMARKS_KEY, bookmarks);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Rename a bookmark */
  async rename(id: string, newName: string): Promise<void> {
    const bookmarks = this.getAll().map(b => b.id === id ? { ...b, name: newName } : b);
    await this.context.globalState.update(BOOKMARKS_KEY, bookmarks);
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
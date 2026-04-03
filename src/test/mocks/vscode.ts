/**
 * Minimal mock of the 'vscode' module for unit tests that run outside the VS Code
 * extension host.  Only the APIs used by the modules under test are implemented.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── DiagnosticSeverity ────────────────────────────────────────────────────────
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

// ── Position ──────────────────────────────────────────────────────────────────
export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

// ── Range ─────────────────────────────────────────────────────────────────────
export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

// ── Diagnostic ────────────────────────────────────────────────────────────────
export class Diagnostic {
  public code: string | number | undefined;
  public source: string | undefined;
  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

// ── DiagnosticCollection ──────────────────────────────────────────────────────
export function createDiagnosticCollection(_name?: string) {
  const store = new Map<string, Diagnostic[]>();
  return {
    set(uri: { toString(): string }, diags: Diagnostic[]) {
      store.set(uri.toString(), diags);
    },
    get(uri: { toString(): string }): Diagnostic[] {
      return store.get(uri.toString()) ?? [];
    },
    delete(uri: { toString(): string }) {
      store.delete(uri.toString());
    },
    clear() {
      store.clear();
    },
    dispose() {
      store.clear();
    },
  };
}

// ── languages namespace ───────────────────────────────────────────────────────
export const languages = {
  createDiagnosticCollection,
};

// ── TreeItemCollapsibleState ──────────────────────────────────────────────────
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

// ── TreeItem ──────────────────────────────────────────────────────────────────
export class TreeItem {
  public tooltip: string | undefined;
  public description: string | undefined;
  public contextValue: string | undefined;
  public command: any;
  public iconPath: any;
  constructor(
    public readonly label: string,
    public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

// ── ThemeIcon ─────────────────────────────────────────────────────────────────
export class ThemeIcon {
  constructor(public readonly id: string) {}
}

// ── EventEmitter ─────────────────────────────────────────────────────────────
export class EventEmitter<T> {
  private _listeners: Array<(e: T) => void> = [];

  get event() {
    return (listener: (e: T) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    };
  }

  fire(data: T) {
    for (const l of this._listeners) {
      l(data);
    }
  }

  dispose() {
    this._listeners = [];
  }
}

// ── Uri ───────────────────────────────────────────────────────────────────────
export class Uri {
  private constructor(private readonly _str: string) {}
  static parse(str: string): Uri { return new Uri(str); }
  static file(path: string): Uri { return new Uri(`file://${path}`); }
  toString(): string { return this._str; }
}

// ── workspace ─────────────────────────────────────────────────────────────────
export const workspace = {
  onDidOpenTextDocument: (_handler: any) => ({ dispose: () => { /* no-op */ } }),
  onDidChangeTextDocument: (_handler: any) => ({ dispose: () => { /* no-op */ } }),
  onDidCloseTextDocument: (_handler: any) => ({ dispose: () => { /* no-op */ } }),
  textDocuments: [] as any[],
  getConfiguration: (_section?: string) => ({
    get: (_key: string, defaultValue?: any) => defaultValue,
    has: (_key: string) => false,
    inspect: (_key: string) => undefined,
    update: (_key: string, _value: any) => Promise.resolve(),
  }),
};

// ── window ────────────────────────────────────────────────────────────────────

/** Minimal OutputChannel stub */
class FakeOutputChannel {
  appendLine(_value: string) { /* no-op */ }
  append(_value: string) { /* no-op */ }
  replace(_value: string) { /* no-op */ }
  clear() { /* no-op */ }
  show() { /* no-op */ }
  hide() { /* no-op */ }
  dispose() { /* no-op */ }
}

export const window = {
  createOutputChannel: (_name: string) => new FakeOutputChannel(),
  showInformationMessage: (_msg: string, ..._rest: any[]) => Promise.resolve(undefined),
  showWarningMessage: (_msg: string, ..._rest: any[]) => Promise.resolve(undefined),
  showErrorMessage: (_msg: string, ..._rest: any[]) => Promise.resolve(undefined),
  createStatusBarItem: (_alignment?: any, _priority?: number) => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  }),
  showInputBox: (_options?: any) => Promise.resolve(undefined as string | undefined),
  showQuickPick: (_items: any, _options?: any) => Promise.resolve(undefined),
  createWebviewPanel: () => ({
    webview: { html: '', postMessage: () => {}, onDidReceiveMessage: () => ({ dispose: () => {} }), asWebviewUri: (uri: any) => uri },
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => { /* no-op */ },
  }),
  activeTextEditor: undefined as any,
};

// ── ExtensionContext helpers ──────────────────────────────────────────────────

// ── StatusBarAlignment ────────────────────────────────────────────────────────
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// ── ViewColumn ────────────────────────────────────────────────────────────────
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

// ── commands namespace ────────────────────────────────────────────────────────
export const commands = {
  registerCommand: (_command: string, _callback: (...args: any[]) => any) => ({ dispose: () => { /* no-op */ } }),
  executeCommand: (_command: string, ..._rest: any[]) => Promise.resolve(undefined),
};

// ── extensions namespace ──────────────────────────────────────────────────────
export const extensions = {
  getExtension: (_id: string) => undefined,
};

// ── env namespace ─────────────────────────────────────────────────────────────
export const env = {
  openExternal: (_uri: any) => Promise.resolve(true),
};

/** Creates a minimal ExtensionContext mock with an in-memory globalState. */
export function createMockContext() {
  const store = new Map<string, any>();
  const subscriptions: any[] = [];
  return {
    subscriptions,
    extensionPath: '/tmp/mock-extension',
    extensionUri: Uri.file('/tmp/mock-extension'),
    globalState: {
      get<T>(key: string, defaultValue?: T): T {
        return store.has(key) ? store.get(key) as T : (defaultValue as T);
      },
      async update(key: string, value: any): Promise<void> {
        store.set(key, value);
      },
      keys: () => [...store.keys()],
      setKeysForSync: (_keys: string[]) => { /* no-op */ },
    },
    secrets: {
      get: (_key: string) => Promise.resolve(undefined as string | undefined),
      store: (_key: string, _value: string) => Promise.resolve(),
      delete: (_key: string) => Promise.resolve(),
      onDidChange: (_handler: any) => ({ dispose: () => { /* no-op */ } }),
    },
  };
}

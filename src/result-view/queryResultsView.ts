import {
  WebviewPanel, WebviewView, WebviewViewProvider, Webview, window, commands, ViewColumn, Disposable,
  WebviewPanelOptions, WebviewOptions, Uri, ThemeIcon,
} from "vscode";
import { EventEmitter } from "events";
import { dirname } from "path";
import { readFile } from "fs";
import { logger } from "../logger/logger";

export interface Message {
  command: string;
  data: object;
  id?: string;
}

/**
 * Where a webview is rendered.
 *
 * These are two different APIs, not two arguments to one. **"editor"** is a `WebviewPanel` in an
 * editor group — the only thing `window.createWebviewPanel()` can produce, and the reason results
 * have always taken an editor group however the `ViewColumn` was set. **"panel"** is a
 * `WebviewView` docked in VS Code's bottom Panel: the container and the view are declared in
 * package.json, VS Code constructs the view itself, and it calls a registered provider's
 * `resolveWebviewView()` the first time the view becomes visible.
 *
 * A live webview cannot be moved between the two, so the choice is made per run rather than
 * migrated. That is also why this class hosts *either* — everything below the `webview` accessor is
 * written against the `Webview` both hosts expose, and only the plumbing above it differs.
 */
/**
 * Panel options shared by every webview this base class hosts.
 *
 * `enableFindWidget` gives Ctrl+F inside the webview. VS Code has always had it; it simply
 * defaults to false, so the reflex that works in every editor did nothing in a result grid, a
 * query plan, a schema diagram or the profiler — all four read-heavy panels where looking for a
 * name is the obvious thing to want, and all four share this class.
 *
 * Two limits worth knowing, neither fixable here. It is a `WebviewPanelOptions` flag, so it does
 * **not** reach the bottom-Panel host (`firebird.queryResultsLocation: "panel"`) — a `WebviewView`
 * has no equivalent in the API as of 1.134. And it searches the *rendered DOM*, so it finds what
 * the grid is currently showing: with paging on that is the page on screen, not the whole result
 * set, which is what the grid's own filter is for.
 *
 * Exported so the extension-host tier can assert both halves — that we ask for it, and that the
 * VS Code we run against still honours it. A silently-ignored option is the failure mode a
 * declarative flag actually has.
 */
export const RESULTS_PANEL_OPTIONS: WebviewPanelOptions = {
  enableFindWidget: true,
};

export type WebviewLocation = "editor" | "panel";

export class QueryResultsView extends EventEmitter implements Disposable, WebviewViewProvider {
  // private resourceScheme = "vscode-resource";
  private disposable?: Disposable;

  // private resourcesPath: string;
  private panel: WebviewPanel | undefined;
  /** Set only while this webview is docked in the bottom Panel — see {@link WebviewLocation}. */
  private view: WebviewView | undefined;
  private viewSubscriptions?: Disposable;
  /**
   * The HTML a `show()` asked for while the Panel-hosted view did not exist yet. VS Code builds
   * that view lazily, so the first run after a window opens reaches `show()` before there is any
   * webview to render into; the content is applied by `resolveWebviewView()` when it arrives.
   */
  private pendingHtmlPath?: string;
  private htmlCache: { [path: string]: string };
  /**
   * @param icon Codicon id for the editor tab. Several of these panels can be open at once
   *   (results, plan, designer, profiler) and they all showed the generic editor icon, which made
   *   a busy tab strip unreadable. A `ThemeIcon` follows the theme, so unlike the light/dark PNG
   *   pairs used elsewhere in this extension it needs no assets. Requires VS Code 1.110.
   */
  constructor(private type: string, private title: string, private icon?: string) {
    super();
    // this.resourcesPath = "";
    this.htmlCache = {};
  }

  /**
   * Where this webview wants to render. The base answers "editor" — the behaviour every one of
   * these panels has always had, and the only one the Schema Designer, plan view and profiler
   * support. A subclass that also has a contributed Panel view overrides this *and* sets
   * {@link panelViewId}; both are required, so a half-configured subclass falls back rather than
   * silently rendering nowhere.
   */
  protected preferredLocation(): WebviewLocation {
    return "editor";
  }

  /** The `contributes.views` id this webview docks to when {@link preferredLocation} is "panel". */
  protected panelViewId?: string;

  /** The host currently rendering, whichever kind it is. Undefined before the first show(). */
  protected get webview(): Webview | undefined {
    return this.panel?.webview ?? this.view?.webview;
  }

  show(htmlPath: string) {
    // this.resourcesPath = dirname(htmlPath);
    if (this.preferredLocation() === "panel" && this.panelViewId) {
      this.showInBottomPanel(htmlPath);
      return;
    }

    if (!this.panel) {
      this.init();
    }
    this.render(htmlPath);
  }

  /**
   * Reveals the contributed Panel view and renders into it.
   *
   * The `.focus` command is VS Code's own, auto-registered for every contributed view id — there
   * is no API to construct a `WebviewView` directly, so revealing the view *is* how one gets
   * created, and `resolveWebviewView()` picks the render back up from `pendingHtmlPath`.
   */
  private showInBottomPanel(htmlPath: string) {
    this.pendingHtmlPath = htmlPath;
    if (this.view) {
      this.view.show?.(true);
      this.render(htmlPath);
      return;
    }
    Promise.resolve(commands.executeCommand(`${this.panelViewId}.focus`))
      .then(undefined, (err: any) => logger.error(err?.message ?? err));
  }

  /**
   * VS Code calls this when the contributed Panel view first becomes visible. Registered from
   * extension.ts with `window.registerWebviewViewProvider()`.
   */
  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };

    const subscriptions: Disposable[] = [
      view.webview.onDidReceiveMessage((message: Message) => {
        logger.debug(`Received command from webview | Command: ${message.command}`);
        this.handleMessage(message);
      }),
      view.onDidDispose(() => {
        // Only this host goes away — the object itself is a long-lived singleton owned by
        // context.subscriptions, and a closed Panel must not take its event wiring with it.
        if (this.view === view) {
          this.view = undefined;
        }
        this.viewSubscriptions?.dispose();
        this.viewSubscriptions = undefined;
      }),
    ];
    this.viewSubscriptions = Disposable.from(...subscriptions);

    if (this.pendingHtmlPath) {
      this.render(this.pendingHtmlPath);
    }
  }

  private render(htmlPath: string) {
    this.readWithCache(htmlPath, (html: string) => {
      const webview = this.webview;
      if (!webview) {
        return;
      }
      // little hack to make the html unique so that the webview is reloaded
      webview.html = html.replace(/<\/body>/, `<div id="${this.randomString(8)}"></div></body>`);
    });
  }

  private init() {
    const subscriptions = [];

    const options: WebviewPanelOptions & WebviewOptions = {
      ...RESULTS_PANEL_OPTIONS,
      enableScripts: true,
      retainContextWhenHidden: false, // we dont need to keep the state
      // localResourceRoots: [Uri.parse(this.resourcesPath).with({ scheme: "vscode-resource" })]
    };

    this.panel = window.createWebviewPanel(this.type, this.title, ViewColumn.Two, options);
    if (this.icon) {
      this.panel.iconPath = new ThemeIcon(this.icon);
    }
    subscriptions.push(this.panel);

    subscriptions.push(this.panel.onDidDispose(() => this.dispose()));

    subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: Message) => {
        logger.debug(`Received command from webview | Command: ${message.command}`);
        this.handleMessage(message);
      })
    );

    this.disposable = Disposable.from(...subscriptions);
  }

  private readWithCache(path: string, callback: (html: string) => void) {
    let html: string = "";
    if (path in this.htmlCache) {
      html = this.htmlCache[path];
      callback(html);
    } else {
      readFile(path, "utf8", (_err, content) => {
        html = content || "";
        html = this.replaceUris(html, path);
        this.htmlCache[path] = html;
        callback(html);
      });
    }
  }

  private replaceUris(html: string, htmlPath: string) {

    const path = dirname(htmlPath);
    const x = (str: string): string => {
      // A host exists whenever show() *calls* readWithCache() (init() or resolveWebviewView() always
      // runs first), but readFile() below is async -- the panel can be closed, or the view
      // disposed, in between and clear it before this callback fires. There's nothing to build a
      // webview URI *for* at that point, and render()'s own `if (!webview)` check already discards
      // this result rather than assigning it anywhere, so just return the original string unchanged
      // instead of crashing on a stale non-null assertion.
      const webview = this.webview;
      return webview ? webview.asWebviewUri(Uri.file(path + str)).toString() : str;
    };
    const regex = /(?<=(href|src)=")(.+?)(?=")/g;
    html = html.replace(regex, x);
    return html;
  }

  send(message: Message) {
    const webview = this.webview;
    if (webview) {
      webview.postMessage(message);
      logger.info("Results displayed.");
    }
  }

  randomString(length: number) {
    return Math.round(Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))
      .toString(36)
      .slice(1);
  }

  public handleMessage(_message: Message) {
    logger.info("HANDLE MESSAGE CALLED");

    throw new Error("Method not implemented");
  }

  dispose() {
    if (this.disposable) {
      this.disposable.dispose();
    }
    this.panel = undefined;
  }
}

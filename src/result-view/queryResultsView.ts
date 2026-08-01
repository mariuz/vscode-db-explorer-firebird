import { WebviewPanel, window, ViewColumn, Disposable, WebviewPanelOptions, WebviewOptions, Uri, ThemeIcon} from "vscode";
import { EventEmitter } from "events";
import { dirname } from "path";
import { readFile } from "fs";
import { logger } from "../logger/logger";

export interface Message {
  command: string;
  data: object;
  id?: string;
}

export class QueryResultsView extends EventEmitter implements Disposable {
  // private resourceScheme = "vscode-resource";
  private disposable?: Disposable;

  // private resourcesPath: string;
  private panel: WebviewPanel | undefined;
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

  show(htmlPath: string) {
    // this.resourcesPath = dirname(htmlPath);
    if (!this.panel) {
      this.init();
    }

    this.readWithCache(htmlPath, (html: string) => {
      if (this.panel) {
        // little hack to make the html unique so that the webview is reloaded
        html = html.replace(/<\/body>/, `<div id="${this.randomString(8)}"></div></body>`);
        this.panel.webview.html = html;
      }
    });
  }

  private init() {
    const subscriptions = [];

    const options: WebviewPanelOptions & WebviewOptions = {
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
      // The panel exists whenever show() *calls* readWithCache() (init() always runs first), but
      // readFile() below is async -- dispose() can run in between (e.g. the panel is closed again
      // before its HTML even finished loading) and clear this.panel before this callback fires.
      // There's nothing to build a webview URI *for* at that point, and show()'s own `if
      // (this.panel)` check already discards this result rather than assigning it anywhere, so
      // just return the original string unchanged instead of crashing on a stale non-null assertion.
      return this.panel ? this.panel.webview.asWebviewUri(Uri.file(path + str)).toString() : str;
    };
    const regex = /(?<=(href|src)=")(.+?)(?=")/g;
    html = html.replace(regex, x);
    return html;
  }

  send(message: Message) {
    if (this.panel) {
      this.panel.webview.postMessage(message);
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

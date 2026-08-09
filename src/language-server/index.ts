import { Disposable, languages, TextDocument, workspace } from "vscode";
import { CompletionProvider } from "./completionProvider";
import { HoverProvider } from "./hoverProvider";
import { SqlDocumentSymbolProvider } from "./documentSymbolProvider";
import { SqlDefinitionProvider, DdlDocumentProvider } from "./definitionProvider";
import { DDL_SCHEME } from "./definition-model";
import { FirebirdSchema, Schema } from "../interfaces";

export default class LanguageServer implements Disposable {
  private subscriptions: Disposable[];
  private schemaHandler?: (doc: TextDocument) => Thenable<FirebirdSchema>;
  private completionProvider: CompletionProvider;
  private hoverProvider: HoverProvider;

  constructor() {
    this.subscriptions = [];

    this.completionProvider = new CompletionProvider({
      provideSchema: doc => {
        if (this.schemaHandler) {
          return this.schemaHandler(doc);
        } else {
          return Promise.resolve({} as Schema.Database);
        }
      }
    });

    // Shares the completion provider's schema handler: one cache, two providers, no extra queries.
    this.hoverProvider = new HoverProvider({
      provideSchema: doc =>
        this.schemaHandler ? this.schemaHandler(doc) : Promise.resolve({} as Schema.Database),
    });

    // enable completion, hover, symbols, definition for file, untitled, and notebook cells
    const documentSelector = [
      { scheme: "file", language: "sql" },
      { scheme: "untitled", language: "sql" },
      { scheme: "vscode-notebook-cell", language: "sql" },
    ];
    this.subscriptions.push(languages.registerCompletionItemProvider(documentSelector, this.completionProvider, "*", "."));
    this.subscriptions.push(languages.registerHoverProvider(documentSelector, this.hoverProvider));
    // Needs no schema and no connection — pure text analysis over the statement splitter.
    this.subscriptions.push(languages.registerDocumentSymbolProvider(documentSelector, new SqlDocumentSymbolProvider()));

    // F12 on a table name opens its generated DDL. The content provider is what gives those
    // generated documents a stable identity, so pressing F12 twice reuses one editor.
    this.subscriptions.push(languages.registerDefinitionProvider(documentSelector, new SqlDefinitionProvider({
      provideSchema: doc =>
        this.schemaHandler ? this.schemaHandler(doc) : Promise.resolve({} as Schema.Database),
    })));
    this.subscriptions.push(workspace.registerTextDocumentContentProvider(DDL_SCHEME, new DdlDocumentProvider()));
  }

  setSchemaHandler(schemaHandler: (doc: TextDocument) => Thenable<FirebirdSchema>) {
    this.schemaHandler = schemaHandler;
  }

  dispose() {
    Disposable.from(...this.subscriptions).dispose();
  }
}

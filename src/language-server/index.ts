import { Disposable, languages, TextDocument } from "vscode";
import { CompletionProvider } from "./completionProvider";
import { HoverProvider } from "./hoverProvider";
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

    // enable completion for both saved and unsaved sql files
    const documentSelector = [{ scheme: "file", language: "sql" }, { scheme: "untitled", language: "sql" }];
    this.subscriptions.push(languages.registerCompletionItemProvider(documentSelector, this.completionProvider, "*", "."));
    this.subscriptions.push(languages.registerHoverProvider(documentSelector, this.hoverProvider));
  }

  setSchemaHandler(schemaHandler: (doc: TextDocument) => Thenable<FirebirdSchema>) {
    this.schemaHandler = schemaHandler;
  }

  dispose() {
    Disposable.from(...this.subscriptions).dispose();
  }
}

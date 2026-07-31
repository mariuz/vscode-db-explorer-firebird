import { Disposable, ExtensionContext, workspace } from "vscode";
import { FirebirdNotebookSerializer } from "./serializer";
import { createSqlNotebookController, forgetNotebookConnection, FIREBIRD_NOTEBOOK_TYPE } from "./controller";
import { registerNotebookResultExport } from "./export";

export { FIREBIRD_NOTEBOOK_TYPE } from "./controller";

/** Registers the .fbnb notebook type's serializer + execution controller. Returns disposables for context.subscriptions. */
export function registerSqlNotebook(context: ExtensionContext): Disposable[] {
  const serializerDisposable = workspace.registerNotebookSerializer(
    FIREBIRD_NOTEBOOK_TYPE,
    new FirebirdNotebookSerializer()
  );
  const controller = createSqlNotebookController(context);
  const closeListener = workspace.onDidCloseNotebookDocument(forgetNotebookConnection);
  // Backs the renderer's Export button (docs/roadmap/sql-notebooks.md, phase 4).
  const exportMessaging = registerNotebookResultExport();

  return [serializerDisposable, controller, closeListener, exportMessaging];
}

/**
 * Hover for SQL identifiers, backed by the same cached schema the completion provider uses — see
 * hover-model.ts for the logic and docs/roadmap/sql-language-features.md for why this exists.
 *
 * Thin on purpose: everything worth testing lives in hover-model.ts, and this file is the VS Code
 * adapter around it.
 */

import { Hover, HoverProvider as VSHoverProvider, MarkdownString, Position, TextDocument } from "vscode";
import { FirebirdSchema } from "../interfaces";
import { buildHoverMarkdown, identifierAt } from "./hover-model";

export class HoverProvider implements VSHoverProvider {
  constructor(private readonly schemaProvider: { provideSchema: (doc: TextDocument) => Thenable<FirebirdSchema> }) {}

  public async provideHover(document: TextDocument, position: Position): Promise<Hover | undefined> {
    const identifier = identifierAt(document.lineAt(position.line).text, position.character);
    if (!identifier) {
      return undefined;
    }

    // A hover that throws would surface as an error notification on mouse-move, which is worse
    // than no hover — most commonly this just means no connection is active yet.
    let schema;
    try {
      schema = await this.schemaProvider.provideSchema(document);
    } catch {
      return undefined;
    }

    const markdown = buildHoverMarkdown(identifier, schema as any);
    return markdown ? new Hover(new MarkdownString(markdown)) : undefined;
  }
}

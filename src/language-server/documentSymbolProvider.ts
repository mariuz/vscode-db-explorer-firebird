/**
 * Outline and breadcrumbs for `.sql` files — see symbol-model.ts for the logic and
 * docs/roadmap/sql-language-features.md for why.
 *
 * Thin adapter: everything worth testing is in the model, and unlike the other providers here this
 * one needs no database connection at all, so it works in any SQL file.
 */

import { DocumentSymbol, DocumentSymbolProvider as VSDocumentSymbolProvider, Range, SymbolKind, TextDocument } from "vscode";
import { buildSqlSymbols, SqlSymbolKind } from "./symbol-model";

const KINDS: Record<SqlSymbolKind, SymbolKind> = {
  class: SymbolKind.Class,
  function: SymbolKind.Function,
  event: SymbolKind.Event,
  field: SymbolKind.Field,
  constant: SymbolKind.Constant,
  interface: SymbolKind.Interface,
  method: SymbolKind.Method,
};

export class SqlDocumentSymbolProvider implements VSDocumentSymbolProvider {
  public provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
    return buildSqlSymbols(document.getText()).map(symbol => {
      const range = new Range(document.positionAt(symbol.start), document.positionAt(symbol.end));
      // selectionRange must be contained by range; using the same one keeps "reveal" landing on
      // the whole statement, which is what a reader clicking an outline entry wants to see.
      return new DocumentSymbol(symbol.label, "", KINDS[symbol.kind], range, range);
    });
  }
}

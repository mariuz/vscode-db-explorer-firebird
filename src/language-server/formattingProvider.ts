import {
  DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider, FormattingOptions,
  Position, Range, TextDocument, TextEdit
} from "vscode";
import { formatSQL } from "../shared/sql-formatter";
import { buildFormatOptions } from "./format-model";

/**
 * Makes SQL formatting a real language feature rather than a command.
 *
 * Until now `formatSQL()` was reachable only through `firebird.formatSql`, so `Shift+Alt+F`,
 * `editor.formatOnSave` and `editor.formatOnType` all did nothing in a `.sql` file, and neither
 * "Format Selection" nor formatting a notebook cell was possible at all. Registering the two
 * standard providers gets every one of those for free -- VS Code routes all of them here.
 *
 * Both providers are one class: the whole-document case is the range case over the whole document,
 * and keeping them together means the two can never drift into formatting the same text
 * differently.
 */
export class SqlFormattingProvider
implements DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider {
  constructor(private readonly getKeywordCase: () => unknown) {}

  provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions): TextEdit[] {
    const whole = new Range(
      new Position(0, 0),
      document.lineAt(document.lineCount - 1).range.end
    );
    return this.editsFor(document, whole, options);
  }

  provideDocumentRangeFormattingEdits(
    document: TextDocument, range: Range, options: FormattingOptions
  ): TextEdit[] {
    // VS Code hands over whatever the user selected, which usually stops mid-line. Widening to
    // whole lines is what every built-in range formatter does, and it is what keeps the result
    // from being indented against a fragment of a line it cannot see.
    const widened = new Range(
      new Position(range.start.line, 0),
      document.lineAt(range.end.line).range.end
    );
    return this.editsFor(document, widened, options);
  }

  private editsFor(document: TextDocument, range: Range, options: FormattingOptions): TextEdit[] {
    const text = document.getText(range);
    const formatted = formatSQL(text, buildFormatOptions(options, this.getKeywordCase()));
    // Returning no edit when nothing changed matters: an edit that replaces a range with its own
    // text still dirties the document and still pushes an undo step, so format-on-save would mark
    // every SQL file modified on every save.
    return formatted === text ? [] : [TextEdit.replace(range, formatted)];
  }
}

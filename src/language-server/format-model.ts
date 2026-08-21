import { FormatOptions, KeywordCase } from "../shared/sql-formatter";

/**
 * The parts of VS Code's `FormattingOptions` this formatter cares about. Declared structurally so
 * the model stays testable without importing `vscode`, the same way hover-model/symbol-model do.
 */
export interface EditorFormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
}

/**
 * One indent level, taken from the editor rather than from a setting of our own.
 *
 * VS Code hands a formatting provider the indentation the *document* is currently using -- which
 * already accounts for `editor.tabSize`, `editor.insertSpaces` and, when `detectIndentation` is on
 * (it is by default), what the file itself actually contains. Honouring it means a formatted file
 * keeps the indentation the editor is showing, instead of a second private setting silently
 * disagreeing with the first. A tab is a tab regardless of `tabSize`, since the width of a tab is
 * a rendering choice and not something to bake into the text.
 */
export function indentFromEditor(options: EditorFormattingOptions): string {
  if (!options.insertSpaces) {
    return "\t";
  }
  // A non-positive or non-finite tab size would produce an empty indent, which silently defeats
  // the point of indenting at all; fall back to the formatter's own long-standing four.
  const size = Number.isFinite(options.tabSize) && options.tabSize > 0 ? Math.floor(options.tabSize) : 4;
  return " ".repeat(size);
}

/** Valid values of `firebird.format.keywordCase`; anything else falls back to the default. */
const KEYWORD_CASES: KeywordCase[] = ["upper", "lower", "preserve"];

export function resolveKeywordCase(configured: unknown): KeywordCase {
  return KEYWORD_CASES.includes(configured as KeywordCase) ? (configured as KeywordCase) : "upper";
}

/** Assembles the formatter's options from the editor's own and the user's setting. */
export function buildFormatOptions(
  editorOptions: EditorFormattingOptions,
  keywordCase: unknown
): FormatOptions {
  return {
    indent: indentFromEditor(editorOptions),
    keywordCase: resolveKeywordCase(keywordCase),
  };
}

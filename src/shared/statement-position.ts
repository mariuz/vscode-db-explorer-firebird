/**
 * Mapping a batch statement — and the server's complaint about it — back onto the text it came
 * from. Pure string math, no `vscode`: the driver runs in the extension host, but the same numbers
 * are wanted by the results webview, by editor diagnostics, and by the MCP subprocess, so nothing
 * here may depend on an editor being open.
 *
 * Two coordinate systems meet here and they are easy to confuse:
 *
 * - **Executed text** — whatever string was handed to `Driver.runBatch()`. A whole document, a
 *   selection, one statement picked out by "Run Statement Under Cursor", or a bookmark that was
 *   never in a document at all. Statement offsets and {@link SourcePosition}s in `BatchResult` are
 *   all relative to this.
 * - **The statement** — what the server actually received, one `splitStatementsWithOffsets()`
 *   range. Firebird's own "line N, column M" counts from the first character of *this*, because
 *   each statement is prepared separately.
 *
 * {@link shiftPosition} is the only thing that crosses between them, and it is used twice: once to
 * lift the server's position onto the executed text, and again (in extension.ts) to lift the
 * executed text onto the document when the text was a selection rather than the whole file.
 */

/** A 1-based line/column pair — the numbering users see in the editor's status bar. */
export interface SourcePosition {
  line: number;
  column: number;
}

/** The 1-based line/column of `offset` within `text`. Offsets past the end clamp to the end. */
export function positionAt(text: string, offset: number): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * The offset of `position` within `text` — the inverse of {@link positionAt}. A line or column
 * past the end of what `text` has clamps to the end of that line (or of the text), so a server
 * position that over-runs the statement it describes still lands somewhere real.
 */
export function offsetAt(text: string, position: SourcePosition): number {
  const lines = text.split("\n");
  const lineIndex = Math.max(0, Math.min(position.line - 1, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1;
  }
  const column = Math.max(1, Math.min(position.column, lines[lineIndex].length + 1));
  return offset + column - 1;
}

/**
 * The position Firebird reported inside a statement, if it reported one.
 *
 * Deliberately matches only the `line N, column M` form, which is what DSQL preparation emits and
 * is therefore relative to the statement that was submitted:
 *
 * ```
 * Dynamic SQL Error
 * -SQL error code = -104
 * -Token unknown - line 2, column 8
 * -SELCT
 * ```
 *
 * PSQL stack frames use a different spelling — `At procedure 'TOTALS' line: 5, col: 5` — and are
 * counted inside *that routine's body*, not inside the statement the user ran. Reading one of
 * those would point "line 5" at line 5 of the script that merely said `EXECUTE PROCEDURE TOTALS;`,
 * which is a confidently wrong answer where no answer at all is better. The two spellings are the
 * only reliable way to tell them apart, so the `col:` form is left unmatched on purpose.
 *
 * The first match wins: a message that nests several DSQL errors reports the outermost one first,
 * and that is the one describing the text in hand.
 */
export function parseServerPosition(message: string | undefined): SourcePosition | undefined {
  if (!message) {
    return undefined;
  }
  const match = /\bline\s+(\d+),\s*column\s+(\d+)/i.exec(message);
  if (!match) {
    return undefined;
  }
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
    return undefined;
  }
  return { line, column };
}

/**
 * Reads `relative` — a position counted from the start of some inner text — as a position in the
 * outer text that inner text begins at `base` of.
 *
 * The column only shifts on the first line, which is the whole subtlety: line 2 of a statement
 * starts at column 1 of the document too, however far into its line the statement began.
 */
export function shiftPosition(base: SourcePosition, relative: SourcePosition): SourcePosition {
  return {
    line: base.line + relative.line - 1,
    column: relative.line === 1 ? base.column + relative.column - 1 : relative.column,
  };
}

/** `Line 12, column 8` — one phrasing, so the webview, the log and the notebook agree. */
export function describePosition(position: SourcePosition): string {
  return `Line ${position.line}, column ${position.column}`;
}

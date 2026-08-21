/**
 * Splits a SQL document into individual statements for batch execution.
 *
 * Handles:
 *  - single-quoted string literals (including escaped quotes '')
 *  - line comments (--)
 *  - block comments (slash-star ... star-slash)
 *  - the semicolon statement terminator
 *  - `SET TERM <token> ;` — Firebird isql's terminator-switch directive. The
 *    extension's own snippets (CREATE PROCEDURE/TRIGGER, etc.) wrap PSQL
 *    bodies in `SET TERM ^ ; ... END^ SET TERM ; ^` so that the semicolons
 *    inside the body aren't treated as statement boundaries. SET TERM lines
 *    are consumed to switch the active terminator and are never themselves
 *    emitted as statements (they aren't valid DSQL, only an isql directive).
 *  - PSQL blocks that *don't* use SET TERM: BEGIN...END and CASE...END are
 *    tracked as a nesting depth so a bare `CREATE PROCEDURE ... AS BEGIN
 *    ...; ...; END;` (no SET TERM) is still treated as one statement. A
 *    CREATE/ALTER PROCEDURE/TRIGGER/FUNCTION/PACKAGE BODY or EXECUTE BLOCK
 *    header additionally suppresses splitting until its first BEGIN, so a
 *    `DECLARE VARIABLE ...;` declaration section ahead of BEGIN isn't cut
 *    off (this only matters for the no-SET-TERM fallback; SET TERM already
 *    protects the whole statement regardless of what's in it).
 *
 * Empty / whitespace-only *and* comment-only statements are filtered out — a chunk that's nothing
 * but `-- ...` text (e.g. Database Projects' buildUserCreateDDL() emits a CREATE USER commented
 * out entirely, since a password can't be extracted/recreated) has no actual SQL for the server to
 * run; confirmed directly against a live server that sending one through anyway fails with
 * "Dynamic SQL Error ... Unexpected end of command" rather than silently succeeding as a no-op.
 */
const PSQL_HEADER = /^(CREATE\s+(OR\s+ALTER\s+)?|ALTER\s+|RECREATE\s+)(PROCEDURE|TRIGGER|FUNCTION|PACKAGE\s+BODY)\b|^EXECUTE\s+BLOCK\b/i;

/**
 * True if `text` is empty once line/block comments are stripped — i.e. "nothing but whitespace
 * and/or comments accumulated so far in this statement". Both SET TERM and the PSQL-header
 * lookahead below only special-case a genuine statement boundary; a bare `current.trim() === ""`
 * check missed this whenever a comment came first (e.g. a "-- New/changed procedures" note ahead
 * of a `CREATE OR ALTER PROCEDURE ... BEGIN ... END` block with no SET TERM), since a comment's
 * own text is non-blank and had already been appended into `current` verbatim — the PSQL-header
 * case would then never trigger, and the procedure body's internal `;` got mistaken for the
 * statement terminator, splitting a single CREATE PROCEDURE into two broken fragments.
 */
function isBlankOrCommentsOnly(text: string): boolean {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim() === "";
}

/** One statement's trimmed text plus its `[start, end)` offset range in the original source (see splitStatementsWithOffsets()). */
export interface SqlStatementRange {
  text: string;
  start: number;
  end: number;
}

/**
 * Same boundary-detection logic as splitStatements() (string literals, comments, SET TERM, PSQL
 * BEGIN/END/CASE nesting — see that function's own doc comment), but additionally returns each
 * statement's `[start, end)` offset range in the original source, trimmed the same way its text
 * is: `sql.slice(start, end) === text`. Used by "Run Statement Under Cursor" (docs/roadmap/
 * run-statement-under-cursor.md) to find which statement a cursor offset falls inside; a cursor
 * sitting in pure inter-statement whitespace falls outside every returned range on purpose (a
 * leading comment immediately before a statement is still part of that statement's range, exactly
 * as splitStatements() already includes it in the statement's text) — the caller falls back to its
 * own existing whole-document/selection behavior in that case rather than this function guessing.
 */
export function splitStatementsWithOffsets(sql: string): SqlStatementRange[] {
  const statements: SqlStatementRange[] = [];
  let current = "";
  let stmtStart = 0;
  let terminator = ";";
  let blockDepth = 0;
  let awaitingFirstBegin = false;
  let i = 0;
  const len = sql.length;

  const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_$]/.test(ch);

  /** True if `word` (already uppercase) occurs at `pos` as a whole word, case-insensitively. */
  const matchWord = (pos: number, word: string): boolean => {
    if (sql.slice(pos, pos + word.length).toUpperCase() !== word) {
      return false;
    }
    return !isWordChar(sql[pos - 1]) && !isWordChar(sql[pos + word.length]);
  };

  const flush = (rawEnd: number) => {
    const leadingWs = current.length - current.trimStart().length;
    const trailingWs = current.length - current.trimEnd().length;
    const trimmed = current.trim();
    if (trimmed && !isBlankOrCommentsOnly(trimmed)) {
      statements.push({ text: trimmed, start: stmtStart + leadingWs, end: rawEnd - trailingWs });
    }
    current = "";
    awaitingFirstBegin = false;
  };

  while (i < len) {
    const ch = sql[i];

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        // Unterminated: the rest of the document belongs to this statement. `i` must be advanced
        // to the end too, not left pointing at the comment's own start — the final flush() below
        // uses it as the statement's raw end offset, and leaving it behind would cut the range
        // short of the text it's supposed to span (splitStatementsWithOffsets()'s
        // `sql.slice(start, end) === text` contract).
        current += sql.slice(i);
        i = len;
        break;
      }
      current += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) {
        // Unterminated (a trailing `-- ...` with no newline at end of file) — same as the block
        // comment case above: consume to the end and move `i` with it.
        current += sql.slice(i);
        i = len;
        break;
      }
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Single-quoted string (including '' escaped quotes)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // SET TERM <token> <currentTerminator> — only recognised at a statement boundary
    if (blockDepth === 0 && isBlankOrCommentsOnly(current) && matchWord(i, "SET")) {
      const m = /^SET\s+TERM\s+(\S+)\s*/i.exec(sql.slice(i));
      if (m) {
        const newTerminator = m[1];
        const afterDirective = i + m[0].length;
        if (sql.slice(afterDirective, afterDirective + terminator.length) === terminator) {
          terminator = newTerminator;
          i = afterDirective + terminator.length;
          current = ""; // SET TERM is an isql directive, not a statement to execute
          stmtStart = i;
          continue;
        }
      }
    }

    // CREATE/ALTER/RECREATE PROCEDURE|TRIGGER|FUNCTION|PACKAGE BODY or EXECUTE
    // BLOCK: suppress splitting until the first BEGIN, so a declaration
    // section between AS and BEGIN isn't cut off when SET TERM isn't used.
    if (blockDepth === 0 && !awaitingFirstBegin && isBlankOrCommentsOnly(current) && PSQL_HEADER.test(sql.slice(i))) {
      awaitingFirstBegin = true;
    }

    // PSQL block tracking: BEGIN...END and CASE...END both close on the next
    // unmatched END, so a single depth counter covers both without conflating
    // a CASE expression's END with the enclosing block's END.
    if (matchWord(i, "BEGIN")) {
      blockDepth++;
      awaitingFirstBegin = false;
      current += sql.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (matchWord(i, "CASE")) {
      blockDepth++;
      current += sql.slice(i, i + 4);
      i += 4;
      continue;
    }
    if (matchWord(i, "END")) {
      if (blockDepth > 0) {
        blockDepth--;
      }
      current += sql.slice(i, i + 3);
      i += 3;
      continue;
    }

    // Statement terminator (only ends a statement outside any BEGIN/CASE
    // block, and not while still waiting for a PSQL header's first BEGIN)
    if (blockDepth === 0 && !awaitingFirstBegin && sql.slice(i, i + terminator.length) === terminator) {
      flush(i);
      i += terminator.length;
      stmtStart = i;
      continue;
    }

    current += ch;
    i++;
  }

  flush(i);

  return statements;
}

export function splitStatements(sql: string): string[] {
  return splitStatementsWithOffsets(sql).map(statement => statement.text);
}

/** Where the text that produced no statements came from, which changes what to tell the user. */
export type BatchTextOrigin = "selection" | "document" | "cell";

const ORIGIN_NOUN: Record<BatchTextOrigin, string> = {
  selection: "The selection",
  document: "This file",
  cell: "This cell",
};

/**
 * Why splitting produced nothing, phrased for the user.
 *
 * Running an empty editor used to end at `runBatch()`'s `{ notify: false }` throw, which the
 * command's catch reported as "Oops! Something went wrong. Check the log output for more details!"
 * -- a message that describes a crash, offers a log to read, and is wrong on both counts: nothing
 * went wrong, there was simply nothing to run. mssql closed the same gap in #22682 ("Notify when
 * query text is empty").
 *
 * The three cases are distinguished because they need different answers. Comments specifically:
 * the splitter drops them, so a file of nothing but `--` lines is indistinguishable from an empty
 * one by statement count alone, while to the person looking at it the file is obviously not empty.
 */
export function describeEmptyBatch(text: string, origin: BatchTextOrigin = "document"): string {
  const noun = ORIGIN_NOUN[origin];
  if (!text.trim()) {
    return `Nothing to run — ${noun.toLowerCase()} is empty.`;
  }
  // Strip what the splitter itself discards; whatever is left is what it saw.
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  if (!withoutComments.trim()) {
    return `Nothing to run — ${noun.toLowerCase()} contains only comments.`;
  }
  if (!withoutComments.replace(/;/g, "").trim()) {
    return `Nothing to run — ${noun.toLowerCase()} contains no statements, only semicolons.`;
  }
  return `Nothing to run — no complete SQL statement was found in ${noun.toLowerCase()}.`;
}

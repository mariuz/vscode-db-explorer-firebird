import * as vscode from "vscode";
import { BatchResult } from "./driver";
import { SourcePosition } from "./statement-position";

/**
 * Failed statements from a batch run, published as editor diagnostics.
 *
 * Deliberately a second collection rather than a few more entries in the linter's: `SqlLinter`
 * re-`set()`s the whole of `firebird-sql` on every keystroke, so anything else living there would
 * be wiped by the next debounce tick — and, worse, a run's errors would take the lint results with
 * them. Two collections also let each keep its own lifetime, which differs: lint findings are a
 * property of the text as it is now, while an execution error is a property of the text *as it was
 * when it ran*.
 *
 * That is why the first edit to a document retires its execution diagnostics. A squiggle whose
 * message came from the server describes characters that may no longer be there, and re-running is
 * the natural next action anyway — it clears and republishes. Keeping a stale marker alive while
 * the user types the fix would be claiming knowledge this has no way to have.
 */
export class ExecutionDiagnostics implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("firebird-sql-execution");
  }

  activate(context: vscode.ExtensionContext): void {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => this.collection.delete(event.document.uri)),
      vscode.workspace.onDidCloseTextDocument(doc => this.collection.delete(doc.uri))
    );
    context.subscriptions.push(this.collection);
  }

  /**
   * Replaces `document`'s execution diagnostics with whatever the batch just reported.
   *
   * `text` is the SQL that was actually executed and `baseOffset` where it starts in `document` —
   * the two differ whenever a selection was run, and both come from `activeEditorSql()` so the
   * mapping cannot disagree with the rule that picked the text. A run with no failures clears the
   * document rather than leaving the previous run's errors standing.
   */
  report(document: vscode.TextDocument, text: string, baseOffset: number, results: BatchResult[]): void {
    const diagnostics = statementFailures(results, text).map(failure => {
      const range = new vscode.Range(
        document.positionAt(baseOffset + failure.start),
        document.positionAt(baseOffset + failure.end)
      );
      const diagnostic = new vscode.Diagnostic(range, failure.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = "Firebird";
      return diagnostic;
    });
    this.collection.set(document.uri, diagnostics);
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions = [];
  }
}

/** One failed statement, reduced to what a marker needs: where to underline, and what to say. */
export interface StatementFailure {
  /** Index of the statement within the batch — the results webview numbers its tabs the same way. */
  index: number;
  message: string;
  /** Offsets within the executed text, not within any document. */
  start: number;
  end: number;
  position: SourcePosition;
}

/**
 * Where to underline each failure in a batch.
 *
 * The span is the error position to the end of *its own line*, clipped to the statement — not the
 * whole statement. A `CREATE PROCEDURE` body can be forty lines, and underlining all of it to
 * report a token unknown on line three points at everything, which is the same as pointing at
 * nothing. When the server named no position at all the statement's first line is the honest
 * answer: that is genuinely all that is known.
 *
 * Kept separate from the class, and working in plain offsets, so the arithmetic is testable
 * without a TextDocument to hang it off.
 */
export function statementFailures(results: BatchResult[], text: string): StatementFailure[] {
  const failures: StatementFailure[] = [];
  results.forEach((result, index) => {
    if (!result.error || !result.range || !result.position) {
      return;
    }
    let start = Math.min(result.errorOffset ?? result.range.start, result.range.end);
    const lineEnd = text.indexOf("\n", start);
    let end = Math.min(lineEnd === -1 ? text.length : lineEnd, result.range.end);
    if (end <= start) {
      // An error pointing at the very end of a statement — or at a position the statement does not
      // reach — would underline nothing at all. Widening to the whole statement is the graceful
      // failure: less precise, still visible.
      start = result.range.start;
      end = result.range.end;
    }
    failures.push({
      index,
      message: result.error,
      start,
      end,
      position: result.errorPosition ?? result.position,
    });
  });
  return failures;
}

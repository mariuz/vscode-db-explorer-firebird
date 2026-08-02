/**
 * src/shared/execution-diagnostics.ts — turning failed statements into editor markers.
 *
 * The arithmetic under test is where to underline: the error position to the end of *its* line,
 * clipped to the statement. Underlining a forty-line procedure body to report a bad token on its
 * third line points at everything, which is the same as pointing at nothing.
 */

import * as assert from 'assert';
import { BatchResult } from '../shared/driver';
import { ExecutionDiagnostics, statementFailures } from '../shared/execution-diagnostics';
import { createMockContext } from './mocks/vscode';

/** A failed result shaped the way Driver.runBatch() shapes one. */
function failure(overrides: Partial<BatchResult> & { range: { start: number; end: number } }): BatchResult {
  return {
    sql: 'x',
    durationMs: 1,
    error: 'Token unknown',
    position: { line: 1, column: 1 },
    ...overrides,
  };
}

suite('execution-diagnostics – statementFailures()', function () {

  test('ignores statements that succeeded', function () {
    const text = 'SELECT 1;\nSELECT 2;';
    const results: BatchResult[] = [
      { sql: 'SELECT 1', durationMs: 1, rows: [], range: { start: 0, end: 8 }, position: { line: 1, column: 1 } },
      { sql: 'SELECT 2', durationMs: 1, message: 'ok', range: { start: 10, end: 18 }, position: { line: 2, column: 1 } },
    ];
    assert.deepStrictEqual(statementFailures(results, text), []);
  });

  test('underlines from the error to the end of its line, not the whole statement', function () {
    const text = 'CREATE PROCEDURE P AS\nBEGIN\n  SELCT 1;\nEND';
    const failures = statementFailures(
      [failure({ range: { start: 0, end: text.length }, errorOffset: 30, errorPosition: { line: 3, column: 3 } })],
      text
    );

    assert.strictEqual(failures.length, 1);
    assert.strictEqual(text.slice(failures[0].start, failures[0].end), 'SELCT 1;');
    assert.deepStrictEqual(failures[0].position, { line: 3, column: 3 });
    assert.strictEqual(failures[0].index, 0);
  });

  test('clips the underline to the statement when its last line runs on', function () {
    // Two statements on one line: the first one's marker must not bleed into the second.
    const text = 'SELCT 1; SELECT 2;';
    const failures = statementFailures(
      [failure({ range: { start: 0, end: 8 }, errorOffset: 0, errorPosition: { line: 1, column: 1 } })],
      text
    );

    assert.strictEqual(text.slice(failures[0].start, failures[0].end), 'SELCT 1;');
  });

  test('falls back to the whole statement when the error points past its end', function () {
    const text = 'SELECT 1;';
    const failures = statementFailures(
      [failure({ range: { start: 0, end: 8 }, errorOffset: 8, errorPosition: { line: 1, column: 9 } })],
      text
    );

    assert.strictEqual(failures[0].start, 0, 'an empty range would underline nothing at all');
    assert.strictEqual(failures[0].end, 8);
  });

  test('reports the index of the failing statement within the batch', function () {
    const text = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    const results: BatchResult[] = [
      { sql: 'SELECT 1', durationMs: 1, rows: [], range: { start: 0, end: 8 }, position: { line: 1, column: 1 } },
      failure({ range: { start: 10, end: 18 }, errorOffset: 10, errorPosition: { line: 2, column: 1 } }),
      failure({ range: { start: 20, end: 28 }, errorOffset: 20, errorPosition: { line: 3, column: 1 } }),
    ];

    assert.deepStrictEqual(statementFailures(results, text).map(f => f.index), [1, 2]);
  });

  test('skips a failure from a driver that carried no range (nothing to point at)', function () {
    const results: BatchResult[] = [{ sql: 'SELECT 1', durationMs: 1, error: 'boom' }];
    assert.deepStrictEqual(statementFailures(results, 'SELECT 1;'), []);
  });
});

suite('execution-diagnostics – ExecutionDiagnostics', function () {

  /** Just enough TextDocument for offset -> position conversion. */
  function fakeDocument(text: string, uri = 'file:///q.sql') {
    return {
      uri: { toString: () => uri },
      positionAt(offset: number) {
        const before = text.slice(0, offset);
        const line = before.split('\n').length - 1;
        return { line, character: offset - (before.lastIndexOf('\n') + 1) };
      },
    } as any;
  }

  test('publishes one diagnostic per failed statement, at document coordinates', function () {
    const diagnostics = new ExecutionDiagnostics();
    diagnostics.activate(createMockContext() as any);

    const text = 'SELECT 1;\nSELCT 2;\n';
    const document = fakeDocument(text);
    diagnostics.report(document, text, 0, [
      { sql: 'SELECT 1', durationMs: 1, rows: [], range: { start: 0, end: 8 }, position: { line: 1, column: 1 } },
      failure({
        range: { start: 10, end: 18 }, errorOffset: 10, errorPosition: { line: 2, column: 1 },
        error: 'Token unknown - SELCT',
      }),
    ]);

    const published = (diagnostics as any).collection.get(document.uri);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].message, 'Token unknown - SELCT');
    assert.strictEqual(published[0].source, 'Firebird');
    assert.strictEqual(published[0].range.start.line, 1, 'zero-based for the editor');
    assert.strictEqual(published[0].range.start.character, 0);
    diagnostics.dispose();
  });

  test('offsets by where a selection started in the document', function () {
    const diagnostics = new ExecutionDiagnostics();
    diagnostics.activate(createMockContext() as any);

    // The document has three leading lines; only the fourth was selected and run.
    const document = fakeDocument('-- a\n-- b\n-- c\nSELCT 1;\n');
    const executed = 'SELCT 1;';
    diagnostics.report(document, executed, 15, [
      failure({ range: { start: 0, end: 8 }, errorOffset: 0, errorPosition: { line: 1, column: 1 } }),
    ]);

    const published = (diagnostics as any).collection.get(document.uri);
    assert.strictEqual(published[0].range.start.line, 3, 'the fourth line of the document');
    diagnostics.dispose();
  });

  test('a clean run clears the previous run\'s errors rather than leaving them standing', function () {
    const diagnostics = new ExecutionDiagnostics();
    diagnostics.activate(createMockContext() as any);
    const text = 'SELCT 1;';
    const document = fakeDocument(text);

    diagnostics.report(document, text, 0, [
      failure({ range: { start: 0, end: 8 }, errorOffset: 0, errorPosition: { line: 1, column: 1 } }),
    ]);
    assert.strictEqual((diagnostics as any).collection.get(document.uri).length, 1);

    diagnostics.report(document, text, 0, [
      { sql: 'SELECT 1', durationMs: 1, rows: [], range: { start: 0, end: 8 }, position: { line: 1, column: 1 } },
    ]);
    assert.strictEqual((diagnostics as any).collection.get(document.uri).length, 0);
    diagnostics.dispose();
  });
});

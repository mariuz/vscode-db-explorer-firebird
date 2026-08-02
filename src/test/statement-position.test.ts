/**
 * src/shared/statement-position.ts — the line/column arithmetic behind "a failing statement should
 * say which line it is on".
 *
 * The cases worth pinning are the ones where an off-by-one is invisible until a user is staring at
 * the wrong line: 1-based numbering in both axes, the column shifting only on a statement's first
 * line, and the deliberate refusal to read a PSQL stack frame's line number as if it belonged to
 * the script that was run.
 */

import * as assert from 'assert';
import {
  positionAt, offsetAt, parseServerPosition, shiftPosition, describePosition,
} from '../shared/statement-position';

suite('statement-position – positionAt()', function () {

  test('numbers lines and columns from 1', function () {
    assert.deepStrictEqual(positionAt('SELECT 1', 0), { line: 1, column: 1 });
  });

  test('counts columns within the first line', function () {
    assert.deepStrictEqual(positionAt('SELECT 1', 7), { line: 1, column: 8 });
  });

  test('restarts the column at each newline', function () {
    const text = 'SELECT 1;\nSELECT 2;';
    assert.deepStrictEqual(positionAt(text, 10), { line: 2, column: 1 });
    assert.deepStrictEqual(positionAt(text, 17), { line: 2, column: 8 });
  });

  test('handles CRLF without counting the carriage return as a line', function () {
    const text = 'SELECT 1;\r\nSELECT 2;';
    // The \r stays part of line 1's text, so line 2 still starts right after the \n.
    assert.deepStrictEqual(positionAt(text, 11), { line: 2, column: 1 });
  });

  test('clamps an offset past the end rather than running off it', function () {
    assert.deepStrictEqual(positionAt('SELECT', 999), { line: 1, column: 7 });
  });

  test('clamps a negative offset to the start', function () {
    assert.deepStrictEqual(positionAt('SELECT', -5), { line: 1, column: 1 });
  });
});

suite('statement-position – offsetAt()', function () {

  test('inverts positionAt() on every line', function () {
    const text = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    for (let offset = 0; offset <= text.length; offset++) {
      assert.strictEqual(offsetAt(text, positionAt(text, offset)), offset, `offset ${offset}`);
    }
  });

  test('clamps a column past the end of its line to that line\'s end', function () {
    const text = 'SELECT 1;\nSELECT 2;';
    assert.strictEqual(offsetAt(text, { line: 1, column: 500 }), 9);
  });

  test('clamps a line past the end of the text to the last line', function () {
    const text = 'SELECT 1;\nSELECT 2;';
    assert.strictEqual(offsetAt(text, { line: 99, column: 1 }), 10);
  });
});

suite('statement-position – parseServerPosition()', function () {

  // The three forms below are the only entries in the message catalogue node-firebird ships
  // (lib/firebird.msg.json) that carry a line and column, and node-firebird joins a status vector's
  // messages with ", " (lib/utils.js#lookupMessages) — so these strings are the shapes that
  // actually arrive, not paraphrases of them.

  test('reads "Token unknown - line N, column M" out of a joined status vector', function () {
    const message = 'Dynamic SQL Error, SQL error code = -104, Token unknown - line 2, column 8, SELCT';
    assert.deepStrictEqual(parseServerPosition(message), { line: 2, column: 8 });
  });

  test('reads the "Unexpected end of command" form', function () {
    assert.deepStrictEqual(
      parseServerPosition('Dynamic SQL Error, Unexpected end of command- line 3, column 15'),
      { line: 3, column: 15 }
    );
  });

  test('reads the "At line N, column M" spelling too', function () {
    assert.deepStrictEqual(parseServerPosition('At line 4, column 12'), { line: 4, column: 12 });
  });

  test('tolerates a newline-joined message, which other drivers produce', function () {
    assert.deepStrictEqual(
      parseServerPosition('Dynamic SQL Error\n-Token unknown - line 2, column 8'),
      { line: 2, column: 8 }
    );
  });

  test('ignores a PSQL stack frame, whose line counts inside the routine body', function () {
    // "EXECUTE PROCEDURE TOTALS;" is one line long; the 5 below belongs to TOTALS's own source, so
    // reporting it would point five lines into the user's script for no reason.
    const message = 'exception 1, EX_TOTALS, At procedure \'TOTALS\' line: 5, col: 5';
    assert.strictEqual(parseServerPosition(message), undefined);
  });

  test('ignores an EXECUTE BLOCK frame, same reasoning', function () {
    assert.strictEqual(parseServerPosition('At block line: 3, col: 9'), undefined);
  });

  test('returns undefined for a message with no position at all', function () {
    assert.strictEqual(parseServerPosition('Table unknown\nORDERS'), undefined);
  });

  test('returns undefined for no message', function () {
    assert.strictEqual(parseServerPosition(undefined), undefined);
  });

  test('takes the first position when a message nests several', function () {
    assert.deepStrictEqual(
      parseServerPosition('line 1, column 1\nline 9, column 9'),
      { line: 1, column: 1 }
    );
  });
});

suite('statement-position – shiftPosition()', function () {

  test('is the identity when the inner text starts at the very beginning', function () {
    assert.deepStrictEqual(
      shiftPosition({ line: 1, column: 1 }, { line: 3, column: 7 }),
      { line: 3, column: 7 }
    );
  });

  test('shifts the column only on the first line', function () {
    const base = { line: 10, column: 5 };
    assert.deepStrictEqual(shiftPosition(base, { line: 1, column: 3 }), { line: 10, column: 7 });
    // Line 2 of the statement starts at column 1 of the document however far in the statement began.
    assert.deepStrictEqual(shiftPosition(base, { line: 2, column: 3 }), { line: 11, column: 3 });
  });

  test('composes: a statement inside a selection inside a document', function () {
    const selectionInDocument = { line: 20, column: 4 };
    const statementInSelection = { line: 1, column: 6 };
    const errorInStatement = { line: 1, column: 2 };
    const statementInDocument = shiftPosition(selectionInDocument, statementInSelection);
    assert.deepStrictEqual(
      shiftPosition(statementInDocument, errorInStatement),
      { line: 20, column: 10 }
    );
  });
});

suite('statement-position – describePosition()', function () {

  test('phrases a position the one way', function () {
    assert.strictEqual(describePosition({ line: 12, column: 8 }), 'Line 12, column 8');
  });
});

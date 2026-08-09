import * as assert from 'assert';
import { renderRowsAsMarkdown, renderTableAsMarkdown, rowsToResultTable, NOTEBOOK_RESULT_ROW_CAP } from '../shared/notebook-render';

suite('notebook-render – renderRowsAsMarkdown()', function () {
  test('returns a placeholder for an empty result set', function () {
    assert.strictEqual(renderRowsAsMarkdown([]), '_0 rows returned._');
  });

  test('renders a header row, separator row, and one row per record', function () {
    const md = renderRowsAsMarkdown([{ ID: 1, NAME: 'Alice' }, { ID: 2, NAME: 'Bob' }]);
    assert.strictEqual(
      md,
      '| ID | NAME |\n| --- | --- |\n| 1 | Alice |\n| 2 | Bob |'
    );
  });

  test('renders null/undefined cells as empty', function () {
    const md = renderRowsAsMarkdown([{ ID: 1, NOTE: null }]);
    assert.strictEqual(md, '| ID | NOTE |\n| --- | --- |\n| 1 |  |');
  });

  test('escapes a pipe character inside a cell value', function () {
    const md = renderRowsAsMarkdown([{ TEXT: 'a|b' }]);
    assert.ok(md.includes('a\\|b'), `expected an escaped pipe, got: ${md}`);
  });

  test('collapses embedded newlines to a single space', function () {
    const md = renderRowsAsMarkdown([{ TEXT: 'line1\nline2' }]);
    assert.ok(md.includes('line1 line2'), `expected newline collapsed, got: ${md}`);
  });

  test('truncates beyond maxRows and appends a note', function () {
    const rows = Array.from({ length: 5 }, (_, i) => ({ N: i }));
    const md = renderRowsAsMarkdown(rows, 2);
    assert.ok(md.includes('| 0 |'));
    assert.ok(md.includes('| 1 |'));
    assert.ok(!md.includes('| 2 |'));
    assert.ok(md.includes('_...3 more row(s) not shown._'));
  });

  test('does not append a truncation note when under the limit', function () {
    const md = renderRowsAsMarkdown([{ N: 1 }], 500);
    assert.ok(!md.includes('more row(s) not shown'));
  });
});

suite('notebook-render – renderTableAsMarkdown()', function () {
  test('returns a placeholder for an empty result set', function () {
    assert.strictEqual(renderTableAsMarkdown(['ID', 'NAME'], []), '_0 rows returned._');
  });

  test('renders a header row, separator row, and one row per record', function () {
    const md = renderTableAsMarkdown(['ID', 'NAME'], [['1', 'Alice'], ['2', 'Bob']]);
    assert.strictEqual(
      md,
      '| ID | NAME |\n| --- | --- |\n| 1 | Alice |\n| 2 | Bob |'
    );
  });

  test('escapes a pipe character inside a cell value', function () {
    const md = renderTableAsMarkdown(['TEXT'], [['a|b']]);
    assert.ok(md.includes('a\\|b'), `expected an escaped pipe, got: ${md}`);
  });

  test('collapses embedded newlines to a single space', function () {
    const md = renderTableAsMarkdown(['TEXT'], [['line1\nline2']]);
    assert.ok(md.includes('line1 line2'), `expected newline collapsed, got: ${md}`);
  });

  test('truncates beyond maxRows and appends a note', function () {
    const rows = Array.from({ length: 5 }, (_, i) => [String(i)]);
    const md = renderTableAsMarkdown(['N'], rows, 2);
    assert.ok(md.includes('| 0 |'));
    assert.ok(md.includes('| 1 |'));
    assert.ok(!md.includes('| 2 |'));
    assert.ok(md.includes('_...3 more row(s) not shown._'));
  });

  test('does not append a truncation note when under the limit', function () {
    const md = renderTableAsMarkdown(['N'], [['1']], 500);
    assert.ok(!md.includes('more row(s) not shown'));
  });
});

suite('notebook-render – rowsToResultTable()', function () {
  test('returns an empty, untruncated table for no rows', function () {
    assert.deepStrictEqual(rowsToResultTable([]), { headers: [], rows: [], truncated: false, totalRowCount: 0 });
  });

  test('derives headers from the first row and stringifies every cell', function () {
    const table = rowsToResultTable([{ ID: 1, NAME: 'Alice' }, { ID: 2, NAME: 'Bob' }]);
    assert.deepStrictEqual(table.headers, ['ID', 'NAME']);
    assert.deepStrictEqual(table.rows, [['1', 'Alice'], ['2', 'Bob']]);
    assert.strictEqual(table.truncated, false);
    assert.strictEqual(table.totalRowCount, 2);
  });

  test('keeps a genuine SQL NULL as null, distinct from an empty string', function () {
    const table = rowsToResultTable([{ A: null, B: '', C: undefined }]);
    assert.deepStrictEqual(table.rows, [[null, '', null]]);
  });

  test('decodes a Buffer cell to its string contents', function () {
    const table = rowsToResultTable([{ BLOB: Buffer.from('hello') }]);
    assert.strictEqual(table.rows[0][0], 'hello');
  });

  test('renders a Date cell as an ISO string', function () {
    const table = rowsToResultTable([{ D: new Date('2026-07-16T12:00:00.000Z') }]);
    assert.strictEqual(table.rows[0][0], '2026-07-16T12:00:00.000Z');
  });

  test('JSON-stringifies a plain-object cell', function () {
    const table = rowsToResultTable([{ META: { a: 1 } }]);
    assert.strictEqual(table.rows[0][0], '{"a":1}');
  });

  test('truncates beyond maxRows and reports the untruncated total', function () {
    const rows = Array.from({ length: 5 }, (_, i) => ({ N: i }));
    const table = rowsToResultTable(rows, 2);
    assert.deepStrictEqual(table.rows, [['0'], ['1']]);
    assert.strictEqual(table.truncated, true);
    assert.strictEqual(table.totalRowCount, 5);
  });

  test('does not report truncated when exactly at the cap', function () {
    const rows = Array.from({ length: 2 }, (_, i) => ({ N: i }));
    const table = rowsToResultTable(rows, 2);
    assert.strictEqual(table.truncated, false);
  });

  test('defaults maxRows to NOTEBOOK_RESULT_ROW_CAP', function () {
    const rows = Array.from({ length: NOTEBOOK_RESULT_ROW_CAP + 1 }, (_, i) => ({ N: i }));
    const table = rowsToResultTable(rows);
    assert.strictEqual(table.rows.length, NOTEBOOK_RESULT_ROW_CAP);
    assert.strictEqual(table.truncated, true);
  });
});

suite('notebook-render – resultTableToExcel()', function () {
  test('formats headers and rows as tab-separated values', function () {
    const { resultTableToExcel } = require('../shared/notebook-render');
    const excel = resultTableToExcel(['ID', 'NAME'], [['1', 'Alice'], ['2', 'Bob']]);
    assert.strictEqual(excel, 'ID\tNAME\n1\tAlice\n2\tBob');
  });

  test('handles null values as empty string', function () {
    const { resultTableToExcel } = require('../shared/notebook-render');
    const excel = resultTableToExcel(['ID', 'NOTE'], [['1', null]]);
    assert.strictEqual(excel, 'ID\tNOTE\n1\t');
  });
});

/**
 * Unit coverage for src/result-view/htmlContent/js/app.js's pure helper functions, via its
 * existing `module.exports.__test__` hook (previously unused by any committed test — see
 * src/test/webview-harness.ts's doc comment). These are exactly the functions the file's own
 * section comments already call out as "pure — no DOM/jQuery": SQL-literal/selection helpers,
 * shortcut-combo parsing, and the hand-rolled SVG chart builders.
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'result-view', 'htmlContent', 'js', 'app.js');

suite('result-view app.js – pure helpers (via __test__ hook)', function () {
  let hooks: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    hooks = loadWebviewModule(APP_JS_PATH).__test__;
  });
  suiteTeardown(function () { restore(); });

  suite('sqlLiteral()', function () {
    test('null/undefined/empty-string all become NULL', function () {
      assert.strictEqual(hooks.sqlLiteral(null), 'NULL');
      assert.strictEqual(hooks.sqlLiteral(undefined), 'NULL');
      assert.strictEqual(hooks.sqlLiteral(''), 'NULL');
    });

    test('a plain integer is unquoted', function () {
      assert.strictEqual(hooks.sqlLiteral('42'), '42');
      assert.strictEqual(hooks.sqlLiteral('-7'), '-7');
    });

    test('a decimal is unquoted', function () {
      assert.strictEqual(hooks.sqlLiteral('3.14'), '3.14');
    });

    test('a non-numeric string is quoted and single-quote-escaped', function () {
      assert.strictEqual(hooks.sqlLiteral("O'Brien"), "'O''Brien'");
    });

    test('a numeric-looking-but-not-quite string (e.g. a ZIP with letters) is quoted', function () {
      assert.strictEqual(hooks.sqlLiteral('02139-1A'), "'02139-1A'");
    });
  });

  suite('buildInsertStatement()', function () {
    test('builds one INSERT with values run through sqlLiteral', function () {
      const sql = hooks.buildInsertStatement('CUSTOMERS', ['ID', 'NAME'], ['1', "O'Brien"]);
      assert.strictEqual(sql, "INSERT INTO CUSTOMERS (ID, NAME) VALUES (1, 'O''Brien');");
    });
  });

  suite('buildInClause()', function () {
    test('builds an IN (...) clause with each value through sqlLiteral', function () {
      assert.strictEqual(hooks.buildInClause(['1', '2', 'x']), "IN (1, 2, 'x')");
    });

    test('an empty array produces an empty IN ()', function () {
      assert.strictEqual(hooks.buildInClause([]), 'IN ()');
    });
  });

  suite('selectionRange()', function () {
    test('normalizes an anchor/end pair regardless of drag direction', function () {
      const range = hooks.selectionRange({ row: 3, col: 1 }, { row: 1, col: 4 });
      assert.deepStrictEqual(range, { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 4 });
    });

    test('a single-cell selection collapses to a 1x1 range', function () {
      const range = hooks.selectionRange({ row: 2, col: 2 }, { row: 2, col: 2 });
      assert.deepStrictEqual(range, { rowStart: 2, rowEnd: 2, colStart: 2, colEnd: 2 });
    });
  });

  suite('parseShortcut()', function () {
    test('parses a single key with no modifiers', function () {
      assert.deepStrictEqual(hooks.parseShortcut('g'), { key: 'g', ctrl: false, alt: false, shift: false, meta: false });
    });

    test('parses ctrl+alt+g', function () {
      assert.deepStrictEqual(hooks.parseShortcut('ctrl+alt+g'), { key: 'g', ctrl: true, alt: true, shift: false, meta: false });
    });

    test('ctrlcmd maps to ctrl on a non-mac platform', function () {
      const parsed = hooks.parseShortcut('ctrlcmd+alt+i');
      assert.strictEqual(parsed.ctrl, true);
      assert.strictEqual(parsed.meta, false);
    });

    test('is case-insensitive and tolerates surrounding whitespace', function () {
      assert.deepStrictEqual(hooks.parseShortcut(' CTRL + Alt + G '), { key: 'g', ctrl: true, alt: true, shift: false, meta: false });
    });

    test('an empty/falsy combo returns null', function () {
      assert.strictEqual(hooks.parseShortcut(''), null);
      assert.strictEqual(hooks.parseShortcut(undefined), null);
    });

    test('recognizes cmd/command/win as meta', function () {
      assert.strictEqual(hooks.parseShortcut('cmd+k').meta, true);
      assert.strictEqual(hooks.parseShortcut('win+k').meta, true);
    });
  });

  suite('matchesShortcut()', function () {
    test('matches an event whose key/modifiers exactly match the parsed combo', function () {
      const parsed = hooks.parseShortcut('ctrl+alt+g');
      const event = { key: 'g', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), true);
    });

    test('rejects an event with an extra modifier held down', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'g', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), false);
    });

    test('rejects a different key entirely', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'x', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), false);
    });

    test('a null parsed combo (disabled shortcut) never matches', function () {
      assert.strictEqual(hooks.matchesShortcut({ key: 'g' }, null), false);
    });

    test('key comparison is case-insensitive', function () {
      const parsed = hooks.parseShortcut('ctrl+g');
      const event = { key: 'G', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
      assert.strictEqual(hooks.matchesShortcut(event, parsed), true);
    });
  });

  suite('detectNumericColumns()', function () {
    test('detects a column whose every non-empty value is numeric', function () {
      const headers = [{ title: 'ID' }, { title: 'NAME' }];
      const rows = [['1', 'Alice'], ['2', 'Bob']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), [0]);
    });

    test('a column with even one non-numeric value is excluded', function () {
      const headers = [{ title: 'A' }, { title: 'B' }];
      const rows = [['1', 'x'], ['2', '3']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), [0]);
    });

    test('a column with only empty values is excluded (nothing to sniff)', function () {
      const headers = [{ title: 'A' }];
      const rows = [[''], ['']];
      assert.deepStrictEqual(hooks.detectNumericColumns(headers, rows), []);
    });
  });

  suite('chart SVG builders — return well-formed <svg> markup with one shape per data point', function () {
    test('buildBarChartSvg() emits one <rect> per value, wrapped in an <svg> root', function () {
      const svg = hooks.buildBarChartSvg(['a', 'b', 'c'], [1, 2, 3]);
      assert.ok(svg.startsWith('<svg'), svg);
      assert.strictEqual((svg.match(/<rect/g) || []).length, 3);
    });

    test('buildLineChartSvg() emits one <circle> per value plus a connecting <path>', function () {
      const svg = hooks.buildLineChartSvg(['a', 'b'], [1, 2]);
      assert.ok(svg.includes('<path'), svg);
      assert.strictEqual((svg.match(/<circle/g) || []).length, 2);
    });

    test('buildPieChartSvg() emits one <path> slice per value', function () {
      const svg = hooks.buildPieChartSvg(['a', 'b'], [1, 3]);
      assert.strictEqual((svg.match(/<path/g) || []).length, 2);
    });

    test('buildPieChartSvg() with an all-zero series still returns valid (not NaN-poisoned) markup', function () {
      const svg = hooks.buildPieChartSvg(['a', 'b'], [0, 0]);
      assert.ok(!svg.includes('NaN'), svg);
    });

    test('buildScatterChartSvg() emits one <circle> per (x, y) pair', function () {
      const svg = hooks.buildScatterChartSvg([1, 2, 3], [4, 5, 6]);
      assert.strictEqual((svg.match(/<circle/g) || []).length, 3);
    });
  });

  suite('buildTextView() — Text View mode (docs/roadmap/query-results-enhancements.md, phase 1)', function () {
    test('renders a header line, a dashed separator, and one line per row', function () {
      const text = hooks.buildTextView([{ title: 'ID' }, { title: 'NAME' }], [['1', 'Ada'], ['2', 'Bob']]);
      const lines = text.split('\n');
      assert.strictEqual(lines.length, 4);
      assert.strictEqual(lines[0], 'ID | NAME');
      assert.strictEqual(lines[1], '---+-----');
      assert.strictEqual(lines[2], '1  | Ada ');
      assert.strictEqual(lines[3], '2  | Bob ');
    });

    test('every column is padded to the width of its widest value, header included', function () {
      const text = hooks.buildTextView([{ title: 'X' }], [['a'], ['much-longer-value']]);
      const lines = text.split('\n');
      const width = 'much-longer-value'.length;
      assert.strictEqual(lines[0].length, width); // header padded out to the widest cell
      assert.strictEqual(lines[2].length, width); // the short value padded out too
    });

    test('a header wider than every value still gets its own column width, not truncated', function () {
      const text = hooks.buildTextView([{ title: 'A_LONG_HEADER' }], [['x']]);
      const lines = text.split('\n');
      assert.strictEqual(lines[0], 'A_LONG_HEADER');
      assert.strictEqual(lines[2].trimEnd(), 'x');
      assert.strictEqual(lines[2].length, 'A_LONG_HEADER'.length);
    });

    test('null and undefined cells render as the literal NULL, distinguishing from an empty string', function () {
      const text = hooks.buildTextView([{ title: 'A' }, { title: 'B' }], [[null, undefined], ['', 'x']]);
      const lines = text.split('\n');
      assert.ok(lines[2].startsWith('NULL'), lines[2]);
      // Column B's widest value is "NULL" (4 chars) vs "x" (1 char) -- an empty string still
      // renders as an empty, padded cell, not coerced into "NULL" the way null/undefined are.
      assert.strictEqual(lines[3].split(' | ')[0].trimEnd(), '');
    });

    test('an empty result set (zero rows) still renders a header and separator line, nothing more', function () {
      const text = hooks.buildTextView([{ title: 'ID' }], []);
      assert.strictEqual(text, 'ID\n--');
    });

    test('a numeric cell (not just strings) is stringified correctly', function () {
      const text = hooks.buildTextView([{ title: 'N' }], [[42]]);
      assert.strictEqual(text.split('\n')[2], '42');
    });
  });

  suite('computeSelectionStats() / formatSelectionStats() — selection aggregations (docs/roadmap/query-results-enhancements.md, phase 2)', function () {
    test('an all-numeric selection reports count, sum, avg, min, and max', function () {
      const stats = hooks.computeSelectionStats([['1', '2'], ['3', '4']]);
      assert.strictEqual(stats.count, 4);
      assert.strictEqual(stats.numericCount, 4);
      assert.strictEqual(stats.sum, 10);
      assert.strictEqual(stats.avg, 2.5);
      assert.strictEqual(stats.min, 1);
      assert.strictEqual(stats.max, 4);
    });

    test('a mixed numeric/text selection aggregates only over the numeric cells, but counts every cell', function () {
      const stats = hooks.computeSelectionStats([['1', 'Ada'], ['3', 'Bob']]);
      assert.strictEqual(stats.count, 4);
      assert.strictEqual(stats.numericCount, 2);
      assert.strictEqual(stats.sum, 4);
      assert.strictEqual(stats.min, 1);
      assert.strictEqual(stats.max, 3);
    });

    test('an all-text selection has a count but no numeric aggregates', function () {
      const stats = hooks.computeSelectionStats([['Ada', 'Bob']]);
      assert.strictEqual(stats.count, 2);
      assert.strictEqual(stats.numericCount, 0);
      assert.strictEqual(stats.sum, undefined);
    });

    test('an empty selection reports a zero count', function () {
      const stats = hooks.computeSelectionStats([]);
      assert.strictEqual(stats.count, 0);
      assert.strictEqual(stats.numericCount, 0);
    });

    test('negative numbers and decimals are parsed correctly', function () {
      const stats = hooks.computeSelectionStats([['-5', '2.5']]);
      assert.strictEqual(stats.sum, -2.5);
      assert.strictEqual(stats.min, -5);
      assert.strictEqual(stats.max, 2.5);
    });

    test('a whitespace-padded numeric cell (as copied from a DataTables <td>) still counts as numeric', function () {
      const stats = hooks.computeSelectionStats([[' 7 ']]);
      assert.strictEqual(stats.numericCount, 1);
      assert.strictEqual(stats.sum, 7);
    });

    test('formatSelectionStats() renders count-only for a non-numeric selection', function () {
      assert.strictEqual(hooks.formatSelectionStats({ count: 2, numericCount: 0 }), 'Count: 2');
    });

    test('formatSelectionStats() renders the full aggregate line, rounded to 2 decimals', function () {
      const text = hooks.formatSelectionStats({ count: 3, numericCount: 3, sum: 10, avg: 3.33333, min: 1, max: 6 });
      assert.strictEqual(text, 'Count: 3  Sum: 10  Avg: 3.33  Min: 1  Max: 6');
    });

    test('formatSelectionStats() returns an empty string for no selection at all', function () {
      assert.strictEqual(hooks.formatSelectionStats(null), '');
      assert.strictEqual(hooks.formatSelectionStats({ count: 0, numericCount: 0 }), '');
    });
  });

  suite('resultsFontProperties() — grid font customization (docs/roadmap/query-results-enhancements.md, phase 4)', function () {
    test('both settings unset (0 / "") produces no properties at all', function () {
      assert.deepStrictEqual(hooks.resultsFontProperties(0, ''), {});
    });

    test('a font size alone sets only the size custom property, as a px value', function () {
      assert.deepStrictEqual(hooks.resultsFontProperties(16, ''), { '--fb-results-font-size': '16px' });
    });

    test('a font family alone sets only the family custom property, unchanged', function () {
      assert.deepStrictEqual(hooks.resultsFontProperties(0, 'Consolas, monospace'), { '--fb-results-font-family': 'Consolas, monospace' });
    });

    test('both set together produces both properties', function () {
      assert.deepStrictEqual(
        hooks.resultsFontProperties(14, 'Fira Code'),
        { '--fb-results-font-size': '14px', '--fb-results-font-family': 'Fira Code' }
      );
    });
  });


  suite('statementLocationLabel() / batchTabBadge() — naming the line a statement failed on', function () {
    test('phrases a known position the same way the extension host logs it', function () {
      assert.strictEqual(hooks.statementLocationLabel({ line: 12, column: 8 }), 'Line 12, column 8');
    });

    test('says nothing rather than "Line undefined" when no position came through', function () {
      // Bookmarks and history re-runs have no source to point into, and a result from before the
      // driver carried positions has none either.
      assert.strictEqual(hooks.statementLocationLabel(undefined), '');
      assert.strictEqual(hooks.statementLocationLabel({}), '');
    });

    test('a failed tab shows the line it failed on, not just a warning sign', function () {
      assert.strictEqual(hooks.batchTabBadge({ error: 'boom', errorPosition: { line: 40, column: 1 } }), '⚠ 40');
    });

    test('a failure with no position still marks the tab', function () {
      assert.strictEqual(hooks.batchTabBadge({ error: 'boom' }), '⚠');
    });

    test('a successful statement still badges its row count, and zero rows is not "no count"', function () {
      assert.strictEqual(hooks.batchTabBadge({ rowCount: 7 }), '7');
      assert.strictEqual(hooks.batchTabBadge({ rowCount: 0 }), '0');
      assert.strictEqual(hooks.batchTabBadge({ message: 'Create executed successfully.' }), '✓');
    });
  });

  suite('truncationNote() — a trimmed result must say so (docs/roadmap/large-result-sets.md)', function () {
    test('says nothing when nothing was dropped', function () {
      assert.strictEqual(hooks.truncationNote(undefined, 10), '');
      assert.strictEqual(hooks.truncationNote(0, 10), '');
    });

    test('reports both how many are shown and how many there were', function () {
      const note = hooks.truncationNote(50000, 10000);
      assert.ok(note.includes('10000'), `expected the shown count: ${note}`);
      assert.ok(note.includes('50000'), `expected the original count: ${note}`);
    });

    test('names the setting, so the note is actionable rather than just informative', function () {
      assert.ok(hooks.truncationNote(50000, 10000).includes('firebird.maxResultRows'));
    });

    test('says nothing if the original count is not actually larger', function () {
      // Defensive: a payload where truncatedFrom equals the shown count means nothing was dropped,
      // and claiming otherwise would be worse than staying quiet.
      assert.strictEqual(hooks.truncationNote(10, 10), '');
    });

    test('reports "there are more" without inventing a total when the total is unknown', function () {
      // Select All Records asks for one row more than it displays: getting it proves there are
      // more rows without saying how many. Before this, that path showed no note at all -- exactly
      // a capful of rows looks identical to a table holding exactly that many.
      const note = hooks.truncationNote(undefined, 10000, true);
      assert.ok(note.includes('10000'), note);
      assert.ok(/there are more/i.test(note), note);
      assert.ok(note.includes('firebird.maxResultRows'), note);
      assert.ok(!/10001/.test(note), `the probe row must not leak into the note as a total: ${note}`);
    });

    test('an exact total wins over the "there are more" form', function () {
      const note = hooks.truncationNote(50000, 10000, true);
      assert.ok(note.includes('50000'), note);
    });
  });

  suite('pageRangeLabel() — server-side paging (docs/roadmap/large-result-sets.md, phase 2)', function () {
    test('numbers rows from 1, because people read it', function () {
      assert.ok(hooks.pageRangeLabel(0, 100, false).includes('Rows 1–100'));
      assert.ok(hooks.pageRangeLabel(100, 100, false).includes('Rows 101–200'));
    });

    test('says "of more" rather than a total, since no COUNT(*) is issued', function () {
      const label = hooks.pageRangeLabel(0, 10000, true);
      assert.ok(/of more$/.test(label), label);
    });

    test('the last page states the total it now knows', function () {
      // Reaching a short page is exactly the point at which the total becomes known for free.
      assert.strictEqual(hooks.pageRangeLabel(10000, 42, false), 'Rows 10001–10042 of 10042');
    });

    test('an empty page says so rather than showing an empty range', function () {
      assert.strictEqual(hooks.pageRangeLabel(10000, 0, false), 'No rows at this offset');
    });
  });

  suite('FILTER_OPERATOR_CHOICES — phase 3 push-down', function () {
    test('every operator the grid offers is one the extension host understands', function () {
      // The two lists are in different files and different languages; buildFilteredTableQuery()
      // throws on an unknown operator, so a typo here would be a runtime error in the user's face.
      const known = ['contains', 'startsWith', 'equals', 'notEquals', 'greaterThan', 'lessThan', 'isNull', 'isNotNull'];
      for (const choice of hooks.FILTER_OPERATOR_CHOICES) {
        assert.ok(known.includes(choice.value), `unknown operator: ${choice.value}`);
        assert.ok(choice.label && choice.label.length > 0, `no label for ${choice.value}`);
      }
    });

    test('offers the null checks, which need no value', function () {
      const values = hooks.FILTER_OPERATOR_CHOICES.map((c: any) => c.value);
      assert.ok(values.includes('isNull'));
      assert.ok(values.includes('isNotNull'));
    });
  });

  suite('pagingOrderWarning()', function () {
    test('warns when the statement has no ORDER BY', function () {
      const warning = hooks.pagingOrderWarning(false);
      assert.ok(/ORDER BY/.test(warning), warning);
      assert.ok(/overlap|skip/i.test(warning), warning);
    });

    test('says nothing when the statement is ordered', function () {
      assert.strictEqual(hooks.pagingOrderWarning(true), '');
    });
  });
});

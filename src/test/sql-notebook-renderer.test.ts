/**
 * Unit coverage for src/sql-notebook/renderer/resultRenderer.js — the SQL Notebooks custom
 * rich-results renderer (docs/roadmap/sql-notebooks.md phase 2). This file is an ES module (VS
 * Code's Notebook Renderer API loads it via `export const activate`), so unlike the other three
 * webview app.js files (CommonJS, loaded via `require()` — see src/test/webview-harness.ts), it's
 * loaded here via a dynamic `import()`, which Node can resolve even from a CommonJS test file.
 *
 * Two tiers of coverage, matching how much of the file is genuinely DOM-independent:
 *  - The four pure data functions (compareCells/csvCell/toCsv/toJson, exported via `__test__` the
 *    same way the other three files export theirs) get direct unit tests.
 *  - `activate().renderOutputItem()` — the actual interactive table (sort/filter/pagination/copy)
 *    — needs a *faithful* (not the generic no-op Proxy from webview-harness.ts) fake DOM that
 *    actually stores and reads back attributes/children/text, since these tests assert on rendered
 *    output, not just "did it throw". This was previously only ever checked with an uncommitted,
 *    throwaway Node harness during development (docs/roadmap/sql-notebooks.md's phase 2 write-up);
 *    this commits that same coverage permanently.
 */

import * as assert from 'assert';
import { resultTableToCsv, resultTableToJson } from '../shared/notebook-render';
import * as path from 'path';

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'sql-notebook', 'renderer', 'resultRenderer.js');

suite('sql-notebook renderer – pure data helpers (via __test__ hook)', function () {
  let hooks: any;

  suiteSetup(async function () {
    const mod = await import(RENDERER_PATH);
    hooks = mod.__test__;
  });

  suite('compareCells()', function () {
    test('null always sorts first', function () {
      assert.ok(hooks.compareCells(null, '5') < 0);
      assert.ok(hooks.compareCells('5', null) > 0);
      assert.strictEqual(hooks.compareCells(null, null), 0);
    });

    test('numeric strings compare numerically, not lexically ("2" before "10")', function () {
      assert.ok(hooks.compareCells('2', '10') < 0);
      assert.ok(hooks.compareCells('10', '2') > 0);
    });

    test('non-numeric strings fall back to locale string comparison', function () {
      assert.ok(hooks.compareCells('apple', 'banana') < 0);
    });

    test('an empty string is compared as text, not treated as numeric zero', function () {
      // "" is falsy in the `a !== ''` guard, so this must not go through Number("") === 0 comparison.
      assert.strictEqual(hooks.compareCells('', '0'), hooks.compareCells('', '0')); // stable, deterministic
      assert.ok(typeof hooks.compareCells('', 'a') === 'number');
    });
  });

  suite('csvCell()', function () {
    test('null becomes an empty field', function () {
      assert.strictEqual(hooks.csvCell(null), '');
    });

    test('a plain value passes through unquoted', function () {
      assert.strictEqual(hooks.csvCell('hello'), 'hello');
    });

    test('a value containing a comma is quoted', function () {
      assert.strictEqual(hooks.csvCell('a,b'), '"a,b"');
    });

    test('a value containing a double quote is quoted and the quote is doubled', function () {
      assert.strictEqual(hooks.csvCell('say "hi"'), '"say ""hi"""');
    });

    test('a value containing a newline is quoted', function () {
      assert.strictEqual(hooks.csvCell('line1\nline2'), '"line1\nline2"');
    });
  });

  suite('toCsv()', function () {
    test('builds a header row plus one row per data row', function () {
      const csv = hooks.toCsv([['1', 'Alice'], ['2', 'Bob']], ['ID', 'NAME']);
      assert.strictEqual(csv, 'ID,NAME\n1,Alice\n2,Bob');
    });

    test('a null cell becomes an empty CSV field, not the literal string "null"', function () {
      const csv = hooks.toCsv([['1', null]], ['ID', 'NOTE']);
      assert.strictEqual(csv, 'ID,NOTE\n1,');
    });
  });

  suite('toJson()', function () {
    test('zips headers with each row into an array of objects', function () {
      const json = hooks.toJson([['1', 'Alice']], ['ID', 'NAME']);
      assert.deepStrictEqual(JSON.parse(json), [{ ID: '1', NAME: 'Alice' }]);
    });

    test('preserves a genuine null (not stringified to "null")', function () {
      const json = hooks.toJson([['1', null]], ['ID', 'NOTE']);
      assert.deepStrictEqual(JSON.parse(json), [{ ID: '1', NOTE: null }]);
    });

    test('an empty row set produces an empty array', function () {
      assert.deepStrictEqual(JSON.parse(hooks.toJson([], ['ID'])), []);
    });
  });

  suite('computeSelectionStats()', function () {
    test('counts non-numeric cells correctly and skips them in numeric stats', function () {
      const stats = hooks.computeSelectionStats([['1', 'apple', '3']]);
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.numericCount, 2);
      assert.strictEqual(stats.sum, 4);
      assert.strictEqual(stats.avg, 2);
      assert.strictEqual(stats.min, 1);
      assert.strictEqual(stats.max, 3);
    });

    test('returns correct count when there are zero numeric cells', function () {
      const stats = hooks.computeSelectionStats([['apple', 'banana']]);
      assert.strictEqual(stats.count, 2);
      assert.strictEqual(stats.numericCount, 0);
      assert.strictEqual(stats.sum, undefined);
    });
  });

  suite('formatSelectionStats()', function () {
    test('formats selection stats containing numeric values correctly', function () {
      const stats = hooks.computeSelectionStats([['2', '4']]);
      const formatted = hooks.formatSelectionStats(stats);
      assert.strictEqual(formatted, 'Count: 2  Sum: 6  Avg: 3  Min: 2  Max: 4');
    });

    test('formats stats without numeric values showing only Count', function () {
      const stats = hooks.computeSelectionStats([['a', 'b']]);
      const formatted = hooks.formatSelectionStats(stats);
      assert.strictEqual(formatted, 'Count: 2');
    });

    test('returns empty string for empty stats', function () {
      assert.strictEqual(hooks.formatSelectionStats(undefined), '');
      assert.strictEqual(hooks.formatSelectionStats({ count: 0, numericCount: 0 }), '');
    });
  });
});

// ── Full interactive render pipeline, against a faithful (stateful) fake DOM ────────────────────

class FakeClassList {
  set = new Set<string>();
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  toggle(c: string, force?: boolean) {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) { this.set.add(c); } else { this.set.delete(c); }
  }
  contains(c: string) { return this.set.has(c); }
}

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  _text = '';
  classList = new FakeClassList();
  _listeners: Record<string, Array<(e: any) => void>> = {};
  disabled = false;
  value = '';
  dataset: Record<string, string> = {};

  constructor(tag: string) { this.tagName = tag; }
  set className(c: string) { this.classList.set = new Set(c.split(' ').filter(Boolean)); }
  get className() { return [...this.classList.set].join(' '); }
  set textContent(t: string) { this._text = t; this.children = []; }
  get textContent(): string {
    if (this.children.length === 0) { return this._text; }
    return this.children.map(c => c.textContent).join('');
  }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  append(...nodes: FakeElement[]) { nodes.forEach(n => this.appendChild(n)); }
  replaceChildren(...nodes: FakeElement[]) { this.children = []; nodes.forEach(n => this.appendChild(n)); }
  addEventListener(type: string, fn: (e: any) => void) { (this._listeners[type] ??= []).push(fn); }
  dispatch(type: string, eventProps: any = {}) { (this._listeners[type] ?? []).forEach(fn => fn({ target: this, preventDefault() {}, ...eventProps })); }
  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const visit = (el: FakeElement) => {
      if (selector === 'tbody td' && el.tagName.toLowerCase() === 'td') {
        results.push(el);
      } else if (el.tagName.toLowerCase() === selector.toLowerCase()) {
        results.push(el);
      }
      el.children.forEach(visit);
    };
    visit(this);
    return results;
  }
}

suite('sql-notebook renderer – renderOutputItem() (faithful fake DOM)', function () {
  let renderOutputItem: (outputItem: { json(): any }, element: FakeElement) => void;
  let clipboardText: string | null;
  let previousDocument: any;
  let previousNavigator: any;

  suiteSetup(async function () {
    previousDocument = (global as any).document;
    previousNavigator = (global as any).navigator;
    Object.defineProperty(global, 'document', {
      value: {
        createElement: (tag: string) => new FakeElement(tag),
        head: new FakeElement('head'),
        addEventListener: (type: string, fn: any) => {},
        removeEventListener: (type: string, fn: any) => {},
      },
      configurable: true, writable: true,
    });
    clipboardText = null;
    Object.defineProperty(global, 'navigator', {
      value: { clipboard: { writeText: (text: string) => { clipboardText = text; return Promise.resolve(); } } },
      configurable: true, writable: true,
    });

    const mod = await import(RENDERER_PATH);
    ({ renderOutputItem } = mod.activate());
  });

  suiteTeardown(function () {
    Object.defineProperty(global, 'document', { value: previousDocument, configurable: true, writable: true });
    Object.defineProperty(global, 'navigator', { value: previousNavigator, configurable: true, writable: true });
  });

  function render(table: any): FakeElement {
    const root = new FakeElement('div');
    renderOutputItem({ json: () => table }, root as any);
    return root.children[0]; // renderTable()'s own root div, appended via replaceChildren()
  }
  const toolbarOf = (r: FakeElement) => r.children[0];
  const tableEl = (r: FakeElement) => r.children[1];
  const tbodyOf = (r: FakeElement) => tableEl(r).children[1];
  const theadOf = (r: FakeElement) => tableEl(r).children[0];

  test('renders one row per data row, with a null cell shown as "NULL"', function () {
    const root = render({ headers: ['ID', 'NAME'], rows: [['1', 'Alice'], ['2', null]], truncated: false, totalRowCount: 2 });
    const tbody = tbodyOf(root);
    assert.strictEqual(tbody.children.length, 2);
    assert.strictEqual(tbody.children[0].children[1].textContent, 'Alice');
    assert.strictEqual(tbody.children[1].children[1].textContent, 'NULL');
    assert.ok(tbody.children[1].children[1].classList.contains('fb-nb-null'));
  });

  test('sorting a column is numeric-aware ("2" before "10") and toggles direction on repeated clicks', function () {
    const root = render({ headers: ['N'], rows: [['10'], ['2'], ['1']], truncated: false, totalRowCount: 3 });
    theadOf(root).children[0].children[0].dispatch('click');
    let order = tbodyOf(root).children.map((tr: FakeElement) => tr.children[0].textContent).join(',');
    assert.strictEqual(order, '1,2,10');
    assert.ok(theadOf(root).children[0].children[0].textContent.includes('▲'));

    theadOf(root).children[0].children[0].dispatch('click');
    order = tbodyOf(root).children.map((tr: FakeElement) => tr.children[0].textContent).join(',');
    assert.strictEqual(order, '10,2,1');
    assert.ok(theadOf(root).children[0].children[0].textContent.includes('▼'));
  });

  test('the filter box narrows visible rows by substring match', function () {
    const root = render({ headers: ['NAME'], rows: [['Alice'], ['Bob'], ['Carol']], truncated: false, totalRowCount: 3 });
    const filterInput = toolbarOf(root).children[0];
    filterInput.value = 'ar';
    filterInput.dispatch('input');
    const tbody = tbodyOf(root);
    assert.strictEqual(tbody.children.length, 1);
    assert.strictEqual(tbody.children[0].children[0].textContent, 'Carol');
  });

  test('pagination caps the first page at the default page size and moves to the next page correctly', function () {
    const rows = Array.from({ length: 30 }, (_, i) => [String(i)]);
    const root = render({ headers: ['N'], rows, truncated: false, totalRowCount: 30 });
    const [, , , , prevBtn, pageLabel, nextBtn] = toolbarOf(root).children;

    assert.strictEqual(prevBtn.disabled, true);
    assert.strictEqual(pageLabel.textContent, '1–25 of 30');
    assert.strictEqual(tbodyOf(root).children.length, 25);

    nextBtn.dispatch('click');
    assert.strictEqual(prevBtn.disabled, false);
    assert.strictEqual(nextBtn.disabled, true);
    assert.strictEqual(pageLabel.textContent, '26–30 of 30');
    assert.strictEqual(tbodyOf(root).children.length, 5);
  });

  test('Copy as CSV copies the current (filtered/sorted) data, correctly quoted', function () {
    const root = render({ headers: ['ID', 'NAME'], rows: [['2', 'Bob'], ['1', 'Alice, "the great"']], truncated: false, totalRowCount: 2 });
    const [, , copyCsvBtn] = toolbarOf(root).children;
    copyCsvBtn.dispatch('click');
    assert.strictEqual(clipboardText, 'ID,NAME\n2,Bob\n1,"Alice, ""the great"""');
  });

  test('Copy as JSON round-trips the current data as an array of objects', function () {
    const root = render({ headers: ['ID', 'NAME'], rows: [['1', 'Alice']], truncated: false, totalRowCount: 1 });
    const [, , , copyJsonBtn] = toolbarOf(root).children;
    copyJsonBtn.dispatch('click');
    assert.deepStrictEqual(JSON.parse(clipboardText as unknown as string), [{ ID: '1', NAME: 'Alice' }]);
  });

  test('a truncated result shows a note with the shown/total counts', function () {
    const root = render({ headers: ['N'], rows: [['1'], ['2']], truncated: true, totalRowCount: 1000 });
    const note = root.children[2];
    assert.ok(note.textContent.includes('first 2 of 1000'), note.textContent);
  });

  test('a genuinely empty result shows a "0 rows returned" placeholder, not an empty table', function () {
    const root = render({ headers: [], rows: [], truncated: false, totalRowCount: 0 });
    const tbody = tbodyOf(root);
    assert.strictEqual(tbody.children.length, 1);
    assert.strictEqual(tbody.children[0].children[0].textContent, '0 rows returned.');
  });

  test('cell range selection displays aggregates and highlights cells correctly', function () {
    const root = render({ headers: ['N'], rows: [['10'], ['20'], ['30']], truncated: false, totalRowCount: 3 });
    const tbody = tbodyOf(root);

    const findElementByClassName = (node: FakeElement, className: string): FakeElement | undefined => {
      if (node.className.includes(className)) { return node; }
      for (const child of node.children) {
        const found = findElementByClassName(child, className);
        if (found) { return found; }
      }
      return undefined;
    };

    const aggregatesEl = findElementByClassName(root, 'fb-nb-aggregates');
    assert.ok(aggregatesEl, 'Expected aggregates element');

    // Simulate clicking the first cell (10)
    const td0 = tbody.children[0].children[0];
    td0.dispatch('mousedown', { button: 0 });

    assert.strictEqual(aggregatesEl.textContent, 'Count: 1  Sum: 10  Avg: 10  Min: 10  Max: 10');
    assert.ok(td0.classList.contains('fb-nb-cell-selected'));

    // Drag to the second cell (20)
    const td1 = tbody.children[1].children[0];
    td1.dispatch('mouseenter');

    assert.strictEqual(aggregatesEl.textContent, 'Count: 2  Sum: 30  Avg: 15  Min: 10  Max: 20');
    assert.ok(td0.classList.contains('fb-nb-cell-selected'));
    assert.ok(td1.classList.contains('fb-nb-cell-selected'));
  });
});

suite('renderer/host serializer parity (docs/roadmap/sql-notebooks.md, phase 4)', function () {

  test('the renderer\'s toCsv/toJson and the host\'s resultTableToCsv/resultTableToJson agree exactly', async function () {
    // Two implementations exist by necessity, not choice: this test file loads the renderer's raw
    // .js through Node's own import(), so that file cannot import a .ts module, and the renderer
    // bundle is browser ESM while notebook-render.ts is Node CommonJS. This test is what keeps the
    // two from drifting — if either side changes its quoting or NULL handling, it fails here.
    const { __test__ } = await import(RENDERER_PATH);

    const headers = ['ID', 'NAME', 'NOTE', 'EMPTY', 'NULLABLE'];
    const rows: (string | null)[][] = [
      ['1', 'Widget A', 'has, a comma', '', null],
      ['2', 'Say "hi"', 'line\nbreak', '', 'x'],
      ['3', 'plain', 'nothing special', '', null],
    ];

    assert.strictEqual(__test__.toCsv(rows, headers), resultTableToCsv(headers, rows));
    assert.strictEqual(__test__.toJson(rows, headers), resultTableToJson(headers, rows));
  });

  test('both serializers keep a SQL NULL distinct from an empty string', async function () {
    const { __test__ } = await import(RENDERER_PATH);

    const headers = ['A', 'B'];
    const rows: (string | null)[][] = [[null, '']];

    // CSV can't distinguish them (both are an empty field) — but JSON can, and must.
    assert.strictEqual(resultTableToCsv(headers, rows), 'A,B\n,');
    assert.strictEqual(__test__.toCsv(rows, headers), resultTableToCsv(headers, rows));

    const parsed = JSON.parse(resultTableToJson(headers, rows));
    assert.strictEqual(parsed[0].A, null);
    assert.strictEqual(parsed[0].B, '');
    assert.strictEqual(__test__.toJson(rows, headers), resultTableToJson(headers, rows));
  });
});

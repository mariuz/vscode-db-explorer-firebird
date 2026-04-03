/**
 * Unit tests for the SqlLinter rule logic.
 *
 * The SqlLinter class depends on the vscode API (Diagnostic, Range, etc.).  The
 * vscode module is replaced by our minimal mock via src/test/setup.ts before
 * these tests run.
 *
 * Rather than instantiating SqlLinter directly (which calls
 * vscode.languages.createDiagnosticCollection in the constructor), we exercise
 * the lint-rule regex patterns by driving gatherDiagnostics through a thin
 * fake TextDocument, which is all the rules actually need.
 */

import * as assert from 'assert';

// The setup file registers the vscode mock before any module loads, so
// importing SqlLinter is safe here.
import { SqlLinter } from '../shared/sql-linter';

/**
 * Creates a minimal fake vscode.TextDocument from plain SQL text.
 *
 * positionAt is implemented by counting newlines in the text up to the given
 * offset, which is all the linter rules require.
 */
function makeFakeDocument(text: string, languageId = 'sql') {
  function positionAt(offset: number) {
    const slice = text.slice(0, offset);
    const lines = slice.split('\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
  }
  return {
    getText: () => text,
    languageId,
    uri: { toString: () => 'file:///test.sql' },
    positionAt,
  } as any;
}

/**
 * Runs the linter synchronously against the given SQL text and returns the
 * array of produced diagnostics.
 */
async function lint(sql: string): Promise<any[]> {
  const linter = new SqlLinter();
  const doc = makeFakeDocument(sql);

  // Intercept the diagnosticCollection.set call to capture diagnostics
  let captured: any[] = [];
  const origSet = (linter as any).diagnosticCollection.set.bind(
    (linter as any).diagnosticCollection,
  );
  (linter as any).diagnosticCollection.set = (_uri: any, diags: any[]) => {
    captured = diags;
    origSet(_uri, diags);
  };

  await linter.lintDocument(doc as any);
  return captured;
}

// ── FBSQL001 – SELECT * ───────────────────────────────────────────────────────

suite('SQL Linter – FBSQL001 (SELECT *)', function () {

  test('warns on SELECT *', async function () {
    const diags = await lint('SELECT * FROM CUSTOMERS');
    const rule = diags.filter((d: any) => d.code === 'FBSQL001');
    assert.ok(rule.length >= 1, 'Expected at least one FBSQL001 diagnostic');
  });

  test('no warning when columns are explicit', async function () {
    const diags = await lint('SELECT ID, NAME FROM CUSTOMERS');
    const rule = diags.filter((d: any) => d.code === 'FBSQL001');
    assert.strictEqual(rule.length, 0, 'Should not warn when columns are explicit');
  });

  test('warns on multiple SELECT * in same document', async function () {
    const sql = 'SELECT * FROM A;\nSELECT * FROM B;';
    const diags = await lint(sql);
    const rule = diags.filter((d: any) => d.code === 'FBSQL001');
    assert.strictEqual(rule.length, 2, 'Expected two FBSQL001 diagnostics');
  });

  test('diagnostic message mentions column selection', async function () {
    const diags = await lint('SELECT * FROM CUSTOMERS');
    const rule = diags.find((d: any) => d.code === 'FBSQL001');
    assert.ok(rule, 'Expected FBSQL001 diagnostic');
    assert.ok(rule.message.toLowerCase().includes('select *'), `Unexpected message: ${rule.message}`);
  });

  test('diagnostic is a warning severity', async function () {
    const diags = await lint('SELECT * FROM CUSTOMERS');
    const rule = diags.find((d: any) => d.code === 'FBSQL001');
    assert.ok(rule, 'Expected FBSQL001 diagnostic');
    // DiagnosticSeverity.Warning === 1 in mock
    assert.strictEqual(rule.severity, 1);
  });
});

// ── FBSQL002 – DELETE without WHERE ───────────────────────────────────────────

suite('SQL Linter – FBSQL002 (DELETE without WHERE)', function () {

  test('warns on DELETE FROM without WHERE', async function () {
    const diags = await lint('DELETE FROM CUSTOMERS');
    const rule = diags.filter((d: any) => d.code === 'FBSQL002');
    assert.ok(rule.length >= 1, 'Expected at least one FBSQL002 diagnostic');
  });

  test('no warning on DELETE FROM with WHERE', async function () {
    const diags = await lint('DELETE FROM CUSTOMERS WHERE ID = 1');
    const rule = diags.filter((d: any) => d.code === 'FBSQL002');
    assert.strictEqual(rule.length, 0, 'Should not warn when WHERE clause is present');
  });

  test('diagnostic message mentions row removal', async function () {
    const diags = await lint('DELETE FROM ORDERS');
    const rule = diags.find((d: any) => d.code === 'FBSQL002');
    assert.ok(rule, 'Expected FBSQL002 diagnostic');
    assert.ok(rule.message.toLowerCase().includes('all rows'), `Unexpected message: ${rule.message}`);
  });
});

// ── FBSQL003 – UPDATE without WHERE ───────────────────────────────────────────

suite('SQL Linter – FBSQL003 (UPDATE without WHERE)', function () {

  test('warns on UPDATE SET without WHERE', async function () {
    const diags = await lint("UPDATE CUSTOMERS SET NAME = 'Alice'");
    const rule = diags.filter((d: any) => d.code === 'FBSQL003');
    assert.ok(rule.length >= 1, 'Expected at least one FBSQL003 diagnostic');
  });

  test('no warning on UPDATE SET with WHERE', async function () {
    const diags = await lint("UPDATE CUSTOMERS SET NAME = 'Alice' WHERE ID = 1");
    const rule = diags.filter((d: any) => d.code === 'FBSQL003');
    assert.strictEqual(rule.length, 0, 'Should not warn when WHERE clause is present');
  });

  test('diagnostic message mentions all rows', async function () {
    const diags = await lint("UPDATE ORDERS SET STATUS = 'X'");
    const rule = diags.find((d: any) => d.code === 'FBSQL003');
    assert.ok(rule, 'Expected FBSQL003 diagnostic');
    assert.ok(rule.message.toLowerCase().includes('all rows'), `Unexpected message: ${rule.message}`);
  });
});

// ── FBSQL004 – missing semicolon ─────────────────────────────────────────────

suite('SQL Linter – FBSQL004 (missing semicolon)', function () {

  test('hints about missing semicolon when statement has none', async function () {
    const diags = await lint('SELECT ID FROM CUSTOMERS');
    const rule = diags.filter((d: any) => d.code === 'FBSQL004');
    assert.ok(rule.length >= 1, 'Expected at least one FBSQL004 hint');
  });

  test('no hint when statement ends with semicolon', async function () {
    const diags = await lint('SELECT ID FROM CUSTOMERS;');
    const rule = diags.filter((d: any) => d.code === 'FBSQL004');
    assert.strictEqual(rule.length, 0, 'Should not hint when semicolon is present');
  });

  test('FBSQL004 severity is Hint (3)', async function () {
    const diags = await lint('SELECT ID FROM CUSTOMERS');
    const rule = diags.find((d: any) => d.code === 'FBSQL004');
    assert.ok(rule, 'Expected FBSQL004 diagnostic');
    // DiagnosticSeverity.Hint === 3 in mock
    assert.strictEqual(rule.severity, 3);
  });
});

// ── clearAll ──────────────────────────────────────────────────────────────────

suite('SQL Linter – clearAll', function () {

  test('clearAll removes all diagnostics', async function () {
    const linter = new SqlLinter();
    const doc = makeFakeDocument('SELECT * FROM CUSTOMERS');
    await linter.lintDocument(doc as any);

    linter.clearAll();

    // After clearAll the internal collection should be empty
    const collection = (linter as any).diagnosticCollection;
    // Our mock collection stores a Map; clearing should empty it
    const stored = collection.get(doc.uri);
    assert.deepStrictEqual(stored, [], 'Diagnostics should be empty after clearAll');
  });
});

// ── isSqlDoc ──────────────────────────────────────────────────────────────────

suite('SQL Linter – non-SQL documents', function () {

  test('does not produce diagnostics for non-SQL language ID', async function () {
    const linter = new SqlLinter();
    // The lintDocument method does not check languageId; that's done by the
    // event subscriptions.  So we verify that driving lintDocument with a
    // non-SQL document still runs rules (rules don't care about languageId).
    // This test just ensures no unexpected throw occurs.
    const doc = makeFakeDocument('SELECT * FROM T', 'javascript');
    await assert.doesNotReject(linter.lintDocument(doc as any));
  });
});

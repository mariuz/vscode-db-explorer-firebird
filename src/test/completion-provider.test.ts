/**
 * Unit tests for the SQL context detection logic in CompletionProvider.
 *
 * The getSqlContext() function is a pure function that analyses the text before
 * the cursor and returns the appropriate SqlContext.  These tests run entirely
 * in Node.js – no VS Code host is required.
 */

import * as assert from 'assert';
import { getSqlContext, SqlContext, tableCompletionParts, rankingSearchPath, rankedSortText } from '../language-server/completionProvider';
import { Schema } from '../interfaces';

/** A table as db-words.provider builds it — fields are irrelevant to every test below. */
const table = (name: string, schema?: string): Schema.Table => ({ name, schema, fields: [] });

// ── General context ───────────────────────────────────────────────────────────

suite('CompletionProvider – getSqlContext (General)', function () {

  test('returns General for empty string', function () {
    assert.strictEqual(getSqlContext(''), SqlContext.General);
  });

  test('returns General for plain SELECT', function () {
    assert.strictEqual(getSqlContext('SELECT '), SqlContext.General);
  });

  test('returns General for fully formed SELECT statement', function () {
    assert.strictEqual(getSqlContext('SELECT ID, NAME FROM CUSTOMERS WHERE ID = 1 '), SqlContext.General);
  });

  test('returns General for mid-WHERE clause', function () {
    assert.strictEqual(getSqlContext('SELECT * FROM T WHERE '), SqlContext.General);
  });

  test('returns General for ORDER BY context', function () {
    assert.strictEqual(getSqlContext('SELECT ID FROM T ORDER BY '), SqlContext.General);
  });
});

// ── FROM clause context ────────────────────────────────────────────────────────

suite('CompletionProvider – getSqlContext (FromClause)', function () {

  test('detects FROM with comma-terminated table list', function () {
    // The regex requires at least one comma-terminated word after FROM
    assert.strictEqual(getSqlContext('SELECT * FROM T1,'), SqlContext.FromClause);
  });

  test('detects JOIN with comma-terminated table', function () {
    assert.strictEqual(getSqlContext('SELECT * FROM A INNER JOIN B,'), SqlContext.FromClause);
  });

  test('detects INTO keyword (INSERT INTO) with table list', function () {
    assert.strictEqual(getSqlContext('INSERT INTO T1,'), SqlContext.FromClause);
  });

  test('detects UPDATE with comma-terminated table', function () {
    assert.strictEqual(getSqlContext('UPDATE T1,'), SqlContext.FromClause);
  });

  test('detects FROM after multiple comma-separated tables', function () {
    assert.strictEqual(getSqlContext('SELECT A, B FROM T1, T2,'), SqlContext.FromClause);
  });

  test('returns General for FROM with no table name yet', function () {
    // trimEnd() removes the trailing space, so the regex has nothing to match after FROM
    assert.strictEqual(getSqlContext('SELECT * FROM '), SqlContext.General);
  });
});

// ── DDL object context ────────────────────────────────────────────────────────

suite('CompletionProvider – getSqlContext (DdlObject)', function () {

  test('detects CREATE', function () {
    assert.strictEqual(getSqlContext('CREATE '), SqlContext.DdlObject);
  });

  test('detects ALTER', function () {
    assert.strictEqual(getSqlContext('ALTER '), SqlContext.DdlObject);
  });

  test('detects DROP', function () {
    assert.strictEqual(getSqlContext('DROP '), SqlContext.DdlObject);
  });

  test('detects RECREATE', function () {
    assert.strictEqual(getSqlContext('RECREATE '), SqlContext.DdlObject);
  });

  test('detects CREATE OR ALTER', function () {
    assert.strictEqual(getSqlContext('CREATE OR ALTER '), SqlContext.DdlObject);
  });

  test('does not trigger DDL context mid-statement', function () {
    // CREATE inside an identifier context should not fire
    const result = getSqlContext('SELECT CREATE_DATE FROM T ');
    assert.notStrictEqual(result, SqlContext.DdlObject);
  });
});

// ── PSQL block context ────────────────────────────────────────────────────────

suite('CompletionProvider – getSqlContext (PsqlBlock)', function () {

  test('detects BEGIN without END', function () {
    assert.strictEqual(getSqlContext('BEGIN\n  '), SqlContext.PsqlBlock);
  });

  test('returns General when BEGIN and END are balanced', function () {
    assert.notStrictEqual(getSqlContext('BEGIN\nEND'), SqlContext.PsqlBlock);
  });

  test('detects nested BEGIN blocks', function () {
    assert.strictEqual(
      getSqlContext('BEGIN\n  BEGIN\n  '),
      SqlContext.PsqlBlock,
    );
  });

  test('returns non-PSQL when every BEGIN has a matching END', function () {
    const result = getSqlContext('BEGIN\n  x = 1;\nEND\n');
    assert.notStrictEqual(result, SqlContext.PsqlBlock);
  });

  test('detects PSQL context in stored procedure body', function () {
    const procHeader = 'CREATE PROCEDURE MY_PROC AS\nBEGIN\n  ';
    assert.strictEqual(getSqlContext(procHeader), SqlContext.PsqlBlock);
  });
});

suite('tableCompletionParts() — Firebird 6 schemas', function () {
  test('a default-schema table reads bare but inserts qualified', function () {
    // The label is what you read; the inserted text must not depend on the search path.
    const parts = tableCompletionParts({ name: 'ORDERS', schema: 'PUBLIC', fields: [] });
    assert.strictEqual(parts.label, 'ORDERS');
    assert.strictEqual(parts.insertText, 'PUBLIC.ORDERS');
  });

  test('a table from another schema is qualified in both, so the two are distinguishable', function () {
    // Before this, ORDERS in two schemas produced two identical entries.
    const parts = tableCompletionParts({ name: 'ORDERS', schema: 'SALES', fields: [] });
    assert.strictEqual(parts.label, 'SALES.ORDERS');
    assert.strictEqual(parts.insertText, 'SALES.ORDERS');
  });

  test('a table with no schema — every pre-Firebird-6 database — is untouched', function () {
    const parts = tableCompletionParts({ name: 'LEGACY', fields: [] });
    assert.strictEqual(parts.label, 'LEGACY');
    assert.strictEqual(parts.insertText, undefined);
    assert.strictEqual(parts.detail, undefined);
  });
});

// ── Search-path-aware ranking ────────────────────────────────────────────────
//
// The case this exists for: SALES.ORDERS and PUBLIC.ORDERS both exist, the session resolves
// unqualified names through SALES first, and the completion list must offer the one you would
// actually get before the one you would not.

suite('rankingSearchPath() — when ranking applies at all', function () {
  test('a pre-Firebird-6 database is never ranked, so its ordering is unchanged', function () {
    const tables = [table('ORDERS'), table('CUST')];
    assert.strictEqual(rankingSearchPath(tables, 'SELECT 1;', undefined), undefined);
  });

  test('a single-schema Firebird 6 database is not ranked either — there is nothing to rank', function () {
    // Every Firebird 6 database until someone runs CREATE SCHEMA. Ranking here would reorder
    // tables against ~1400 keywords for no benefit whatsoever.
    const tables = [table('ORDERS', 'PUBLIC'), table('CUST', 'PUBLIC')];
    assert.strictEqual(rankingSearchPath(tables, 'SELECT 1;', ['PUBLIC']), undefined);
  });

  test('two schemas turn ranking on, using the connection path', function () {
    const tables = [table('ORDERS', 'PUBLIC'), table('ORDERS', 'SALES')];
    assert.deepStrictEqual(rankingSearchPath(tables, 'SELECT 1;', ['SALES', 'PUBLIC']), ['SALES', 'PUBLIC']);
  });

  test('a SET SEARCH_PATH in the document beats the connection default', function () {
    // What "New Query in Schema…" writes at the top of the document.
    const tables = [table('ORDERS', 'PUBLIC'), table('ORDERS', 'SALES')];
    const sql = 'SET SEARCH_PATH TO HR;\n\nSELECT * FROM ';
    assert.deepStrictEqual(rankingSearchPath(tables, sql, ['SALES', 'PUBLIC']), ['HR']);
  });

  test('with two schemas and no path known anywhere, Firebird own default is assumed', function () {
    const tables = [table('ORDERS', 'PUBLIC'), table('ORDERS', 'SALES')];
    assert.deepStrictEqual(rankingSearchPath(tables, 'SELECT 1;', undefined), ['PUBLIC']);
  });

  test('schema case does not split one schema into two', function () {
    const tables = [table('ORDERS', 'PUBLIC'), table('CUST', 'public')];
    assert.strictEqual(rankingSearchPath(tables, 'SELECT 1;', ['PUBLIC']), undefined);
  });
});

suite('rankedSortText() — the tier itself', function () {
  test('a table on the search path sorts before one that is not', function () {
    const path = ['SALES', 'PUBLIC'];
    const sales = rankedSortText('SALES.ORDERS', table('ORDERS', 'SALES'), path)!;
    const hr = rankedSortText('HR.ORDERS', table('ORDERS', 'HR'), path)!;
    assert.ok(sales < hr, `expected ${sales} to sort before ${hr}`);
  });

  test('earlier on the path sorts first, even against an alphabetically earlier label', function () {
    // PUBLIC.ORDERS labels as bare "ORDERS", which sorts before "SALES.ORDERS" alphabetically —
    // exactly the ordering that made the reachable table hard to find.
    const path = ['SALES', 'PUBLIC'];
    const sales = rankedSortText('SALES.ORDERS', table('ORDERS', 'SALES'), path)!;
    const pub = rankedSortText('ORDERS', table('ORDERS', 'PUBLIC'), path)!;
    assert.ok(sales < pub, `expected ${sales} to sort before ${pub}`);
  });

  test('within one tier the ordering stays alphabetical', function () {
    const path = ['SALES'];
    const a = rankedSortText('SALES.CUST', table('CUST', 'SALES'), path)!;
    const b = rankedSortText('SALES.ORDERS', table('ORDERS', 'SALES'), path)!;
    assert.ok(a < b, `expected ${a} to sort before ${b}`);
  });

  test('the rank is zero-padded, so tier 10 sorts after tier 9 rather than between 1 and 2', function () {
    const path = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const ninth = rankedSortText('X', table('X', 'S9'), path)!;
    const tenth = rankedSortText('X', table('X', 'S10'), path)!;
    const second = rankedSortText('X', table('X', 'S2'), path)!;
    assert.ok(second < ninth && ninth < tenth, `expected ${second} < ${ninth} < ${tenth}`);
  });

  test('no search path means no sortText, leaving VS Code to sort by label as before', function () {
    assert.strictEqual(rankedSortText('ORDERS', table('ORDERS', 'PUBLIC'), undefined), undefined);
  });
});

suite('tableCompletionParts() — ranking', function () {
  test('carries the tier through without touching the label or the inserted text', function () {
    // Ranking answers "which did you mean"; it must not change what accepting the item writes.
    const parts = tableCompletionParts(table('ORDERS', 'SALES'), ['SALES', 'PUBLIC']);
    assert.strictEqual(parts.label, 'SALES.ORDERS');
    assert.strictEqual(parts.insertText, 'SALES.ORDERS');
    assert.strictEqual(parts.sortText, '00SALES.ORDERS');
  });

  test('an off-path table is still offered, just later', function () {
    const parts = tableCompletionParts(table('ORDERS', 'HR'), ['SALES', 'PUBLIC']);
    assert.strictEqual(parts.label, 'HR.ORDERS');
    assert.strictEqual(parts.sortText, '02HR.ORDERS');
  });

  test('an unranked list produces exactly what it always did', function () {
    const parts = tableCompletionParts(table('ORDERS', 'PUBLIC'));
    assert.strictEqual(parts.sortText, undefined);
    assert.strictEqual(parts.label, 'ORDERS');
    assert.strictEqual(parts.insertText, 'PUBLIC.ORDERS');
  });
});

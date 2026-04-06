/**
 * Unit tests for the SQL context detection logic in CompletionProvider.
 *
 * The getSqlContext() function is a pure function that analyses the text before
 * the cursor and returns the appropriate SqlContext.  These tests run entirely
 * in Node.js – no VS Code host is required.
 */

import * as assert from 'assert';
import { getSqlContext, SqlContext } from '../language-server/completionProvider';

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

/**
 * Unit tests for pure utility functions in Driver.
 *
 * Only functions that can be exercised without a live Firebird connection are
 * tested here: Driver.constructResponse() and extractTableNames().
 *
 * All vscode API calls are intercepted by the mock registered in setup.ts.
 */

import * as assert from 'assert';
import { Driver, extractTableNames } from '../shared/driver';

// ── Driver.constructResponse ──────────────────────────────────────────────────

suite('Driver – constructResponse()', function () {

  test('returns "Create" for CREATE statement', function () {
    assert.strictEqual(Driver.constructResponse('CREATE TABLE T (ID INT)'), 'Create');
  });

  test('returns "Insert" for INSERT statement', function () {
    assert.strictEqual(Driver.constructResponse('INSERT INTO T VALUES (1)'), 'Insert');
  });

  test('returns "Alter" for ALTER statement', function () {
    assert.strictEqual(Driver.constructResponse('ALTER TABLE T ADD COL VARCHAR(10)'), 'Alter');
  });

  test('returns "Drop" for DROP statement', function () {
    assert.strictEqual(Driver.constructResponse('DROP TABLE T'), 'Drop');
  });

  test('returns "Delete" for DELETE statement', function () {
    assert.strictEqual(Driver.constructResponse('DELETE FROM T WHERE ID = 1'), 'Delete');
  });

  test('returns null for SELECT statement', function () {
    assert.strictEqual(Driver.constructResponse('SELECT * FROM T'), null);
  });

  test('returns null for UPDATE statement', function () {
    assert.strictEqual(Driver.constructResponse('UPDATE T SET COL = 1'), null);
  });

  test('is case-insensitive', function () {
    assert.strictEqual(Driver.constructResponse('create table t (id int)'), 'Create');
    assert.strictEqual(Driver.constructResponse('INSERT INTO t values (1)'), 'Insert');
    assert.strictEqual(Driver.constructResponse('Drop Table T'), 'Drop');
  });

  test('returns "Create" when keyword appears anywhere in the string', function () {
    // The current implementation uses indexOf, so the keyword anywhere triggers it
    assert.strictEqual(Driver.constructResponse('  create procedure p as begin end'), 'Create');
  });

  test('returns null for empty string', function () {
    assert.strictEqual(Driver.constructResponse(''), null);
  });
});

// ── extractTableNames ─────────────────────────────────────────────────────────

suite('Driver – extractTableNames()', function () {

  test('extracts single table from FROM clause', function () {
    const names = extractTableNames('SELECT * FROM CUSTOMERS');
    assert.deepStrictEqual(names, ['CUSTOMERS']);
  });

  test('extracts table from JOIN clause', function () {
    const names = extractTableNames('SELECT * FROM ORDERS JOIN CUSTOMERS ON ORDERS.ID = CUSTOMERS.ID');
    assert.ok(names.includes('ORDERS'), 'Expected ORDERS');
    assert.ok(names.includes('CUSTOMERS'), 'Expected CUSTOMERS');
    assert.strictEqual(names.length, 2);
  });

  test('extracts multiple JOIN tables', function () {
    const sql = 'SELECT * FROM A JOIN B ON A.X = B.X LEFT JOIN C ON B.Y = C.Y';
    const names = extractTableNames(sql);
    assert.ok(names.includes('A'));
    assert.ok(names.includes('B'));
    assert.ok(names.includes('C'));
    assert.strictEqual(names.length, 3);
  });

  test('returns empty array for non-SELECT SQL', function () {
    const names = extractTableNames('INSERT INTO T VALUES (1)');
    assert.deepStrictEqual(names, []);
  });

  test('returns empty array for empty string', function () {
    assert.deepStrictEqual(extractTableNames(''), []);
  });

  test('deduplicates repeated table names', function () {
    const sql = 'SELECT * FROM T JOIN T ON T.ID = T.PARENT_ID';
    const names = extractTableNames(sql);
    assert.strictEqual(names.filter(n => n === 'T').length, 1, 'T should appear only once');
  });

  test('uppercases extracted names', function () {
    const names = extractTableNames('SELECT * FROM customers');
    assert.deepStrictEqual(names, ['CUSTOMERS']);
  });

  test('handles table names with underscores and digits', function () {
    const names = extractTableNames('SELECT * FROM ORDER_LINE_ITEMS_2024');
    assert.deepStrictEqual(names, ['ORDER_LINE_ITEMS_2024']);
  });
});

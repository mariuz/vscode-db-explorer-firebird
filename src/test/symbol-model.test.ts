/**
 * Outline entries for .sql files — see docs/roadmap/sql-language-features.md.
 */

import * as assert from 'assert';
import { buildSqlSymbols } from '../language-server/symbol-model';

const labels = (sql: string) => buildSqlSymbols(sql).map(s => s.label);

suite('buildSqlSymbols()', function () {
  test('names DDL by verb, object type and object name', function () {
    assert.deepStrictEqual(
      labels('CREATE TABLE CUSTOMERS (ID INTEGER);\nDROP VIEW ACTIVE;'),
      ['CREATE TABLE CUSTOMERS', 'DROP VIEW ACTIVE']
    );
  });

  test('prefers the longer verb, so CREATE OR ALTER is not read as CREATE', function () {
    assert.deepStrictEqual(
      labels('CREATE OR ALTER PROCEDURE TOTALS AS BEGIN END;'),
      ['CREATE OR ALTER PROCEDURE TOTALS']
    );
  });

  test('skips an IF NOT EXISTS clause rather than labelling it as the object name', function () {
    assert.deepStrictEqual(labels('CREATE TABLE IF NOT EXISTS T (ID INTEGER);'), ['CREATE TABLE T']);
  });

  test('names DML by its target table', function () {
    assert.deepStrictEqual(
      labels('INSERT INTO ORDERS (ID) VALUES (1);\nUPDATE ORDERS SET ID = 2;\nDELETE FROM ORDERS;'),
      ['INSERT INTO ORDERS', 'UPDATE ORDERS', 'DELETE FROM ORDERS']
    );
  });

  test('a schema-qualified name is kept whole', function () {
    // Firebird 6 schemas: SALES.ORDERS must not be truncated at the dot.
    assert.deepStrictEqual(labels('CREATE TABLE SALES.ORDERS (ID INTEGER);'), ['CREATE TABLE SALES.ORDERS']);
  });

  test('offsets point back at the statement in the original text', function () {
    const sql = 'SELECT 1 FROM RDB$DATABASE;\nDROP TABLE T;';
    const [first, second] = buildSqlSymbols(sql);
    assert.strictEqual(sql.slice(first.start, first.end), 'SELECT 1 FROM RDB$DATABASE');
    assert.strictEqual(sql.slice(second.start, second.end), 'DROP TABLE T');
  });

  test('a leading comment does not become the label', function () {
    // The splitter includes a preceding comment in the statement's range on purpose, so the label
    // has to look past it or every documented statement would be named "-- ...".
    assert.deepStrictEqual(labels('-- create the table\nCREATE TABLE T (ID INTEGER);'), ['CREATE TABLE T']);
    assert.deepStrictEqual(labels('/* block */ CREATE TABLE T (ID INTEGER);'), ['CREATE TABLE T']);
  });

  test('a comment-only file produces no entries', function () {
    assert.deepStrictEqual(labels('-- just a note\n'), []);
  });

  test('a multi-line statement still yields a one-line label', function () {
    const [symbol] = buildSqlSymbols('CREATE\n  TABLE\n  CUSTOMERS (ID INTEGER);');
    assert.strictEqual(symbol.label, 'CREATE TABLE CUSTOMERS');
  });

  test('an unrecognised statement still gets an entry, truncated', function () {
    // An outline that silently omits statements is worse than one with a generic row: the gap is
    // invisible, so the file looks shorter than it is.
    const long = 'SOMETHING ' + 'X'.repeat(100) + ';';
    const [symbol] = buildSqlSymbols(long);
    assert.ok(symbol, 'expected an entry');
    assert.ok(symbol.label.length <= 60, symbol.label);
    assert.ok(symbol.label.endsWith('…'));
  });

  test('an empty document produces nothing', function () {
    assert.deepStrictEqual(labels(''), []);
    assert.deepStrictEqual(labels('   \n  '), []);
  });

  test('kinds distinguish DDL, DML and transaction control', function () {
    const symbols = buildSqlSymbols('CREATE TABLE T (ID INTEGER);\nINSERT INTO T (ID) VALUES (1);\nCOMMIT;');
    assert.deepStrictEqual(symbols.map(s => s.kind), ['class', 'method', 'event']);
  });
});

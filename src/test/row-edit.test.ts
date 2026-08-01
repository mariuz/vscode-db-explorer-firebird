import * as assert from 'assert';
import {
  NULL_SENTINEL,
  quoteSqlValue,
  assertValidIdentifier,
  buildWhereClause,
  buildUpdateStatement,
  buildInsertStatement,
  buildDeleteStatement,
  buildStatementForChange,
  RowChange,
} from '../shared/row-edit';

suite('quoteSqlValue', function () {

  test('quotes a plain string', function () {
    assert.strictEqual(quoteSqlValue('Widget A'), "'Widget A'");
  });

  test('escapes embedded single quotes by doubling them', function () {
    assert.strictEqual(quoteSqlValue("O'Brien"), "'O''Brien'");
  });

  test('leaves an integer bare (unquoted)', function () {
    assert.strictEqual(quoteSqlValue('42'), '42');
  });

  test('leaves a decimal bare (unquoted)', function () {
    assert.strictEqual(quoteSqlValue('19.99'), '19.99');
  });

  test('leaves a negative number bare (unquoted)', function () {
    assert.strictEqual(quoteSqlValue('-5'), '-5');
  });

  test('quotes an empty string rather than treating it as zero', function () {
    assert.strictEqual(quoteSqlValue(''), "''");
  });

  test('maps the NULL sentinel to the SQL keyword NULL', function () {
    assert.strictEqual(quoteSqlValue(NULL_SENTINEL), 'NULL');
  });

  test('maps the plain-text "<null>" form to NULL too', function () {
    assert.strictEqual(quoteSqlValue('<null>'), 'NULL');
  });

  test('treats a numeric string with surrounding whitespace as a number (Number() trims it)', function () {
    assert.strictEqual(quoteSqlValue('  42  '), '  42  ');
  });
});

suite('assertValidIdentifier', function () {

  test('accepts a simple identifier', function () {
    assert.doesNotThrow(() => assertValidIdentifier('PRODUCTS', 'table name'));
  });

  test('accepts identifiers with underscores, digits, and $', function () {
    assert.doesNotThrow(() => assertValidIdentifier('T1_$NAME', 'table name'));
  });

  test('rejects an identifier starting with a digit', function () {
    assert.throws(() => assertValidIdentifier('1TABLE', 'table name'), /Invalid table name/);
  });

  test('rejects an identifier containing a space', function () {
    assert.throws(() => assertValidIdentifier('MY TABLE', 'table name'), /Invalid table name/);
  });

  test('rejects a SQL-injection attempt', function () {
    assert.throws(() => assertValidIdentifier('T; DROP TABLE X;--', 'table name'));
  });

  test('rejects an empty identifier', function () {
    assert.throws(() => assertValidIdentifier('', 'column name'));
  });
});

suite('buildWhereClause', function () {
  const columns = ['ID', 'NAME', 'PRICE'];

  test('matches on the primary key only when one is known', function () {
    const where = buildWhereClause(columns, ['1', 'Widget A', '9.99'], ['ID']);
    assert.strictEqual(where, 'ID = 1');
  });

  test('matches on a composite primary key', function () {
    const where = buildWhereClause(['A', 'B', 'C'], ['1', '2', '3'], ['A', 'B']);
    assert.strictEqual(where, 'A = 1 AND B = 2');
  });

  test('falls back to matching every column when there is no primary key', function () {
    const where = buildWhereClause(columns, ['1', 'Widget A', '9.99'], []);
    assert.strictEqual(where, "ID = 1 AND NAME = 'Widget A' AND PRICE = 9.99");
  });

  test('uses IS NULL, not = NULL, for a NULL primary key value', function () {
    const where = buildWhereClause(columns, [NULL_SENTINEL, 'Widget A', '9.99'], ['ID']);
    assert.strictEqual(where, 'ID IS NULL');
  });

  test('uses IS NULL for a NULL value in the all-columns fallback', function () {
    const where = buildWhereClause(columns, ['1', NULL_SENTINEL, '9.99'], []);
    assert.strictEqual(where, "ID = 1 AND NAME IS NULL AND PRICE = 9.99");
  });

  test('throws when a primary key column is not among the result columns', function () {
    assert.throws(() => buildWhereClause(columns, ['1', 'Widget A', '9.99'], ['MISSING_COL']), /not found/);
  });

  test('throws when there are no columns at all', function () {
    assert.throws(() => buildWhereClause([], [], []), /no columns/);
  });
});

suite('buildUpdateStatement', function () {
  const columns = ['ID', 'NAME', 'PRICE'];
  const originalRow = ['1', 'Widget A', '9.99'];

  test('builds a single-column UPDATE targeted by primary key', function () {
    const sql = buildUpdateStatement('PRODUCTS', columns, [{ colIndex: 1, newValue: 'Widget B' }], originalRow, ['ID']);
    assert.strictEqual(sql, "UPDATE PRODUCTS SET NAME = 'Widget B' WHERE ID = 1");
  });

  test('builds a multi-column UPDATE', function () {
    const sql = buildUpdateStatement(
      'PRODUCTS',
      columns,
      [{ colIndex: 1, newValue: 'Widget B' }, { colIndex: 2, newValue: '12.50' }],
      originalRow,
      ['ID']
    );
    assert.strictEqual(sql, "UPDATE PRODUCTS SET NAME = 'Widget B', PRICE = 12.50 WHERE ID = 1");
  });

  test('sets a column to NULL when the new value is the NULL sentinel', function () {
    const sql = buildUpdateStatement('PRODUCTS', columns, [{ colIndex: 1, newValue: NULL_SENTINEL }], originalRow, ['ID']);
    assert.ok(sql.includes('NAME = NULL'), sql);
  });

  test('falls back to matching every original column when there is no primary key', function () {
    const sql = buildUpdateStatement('PRODUCTS', columns, [{ colIndex: 1, newValue: 'Widget B' }], originalRow, []);
    assert.ok(sql.includes("WHERE ID = 1 AND NAME = 'Widget A' AND PRICE = 9.99"), sql);
  });

  test('rejects an invalid table name', function () {
    assert.throws(() => buildUpdateStatement('T; DROP TABLE X', columns, [{ colIndex: 0, newValue: '1' }], originalRow, []));
  });

  test('throws when there are no changed fields', function () {
    assert.throws(() => buildUpdateStatement('PRODUCTS', columns, [], originalRow, ['ID']), /No changed fields/);
  });
});

suite('buildInsertStatement', function () {
  const columns = ['ID', 'NAME', 'PRICE'];

  test('builds an INSERT with the provided columns and values', function () {
    const sql = buildInsertStatement('PRODUCTS', columns, [
      { colIndex: 0, value: '6' },
      { colIndex: 1, value: 'Gizmo' },
      { colIndex: 2, value: '3.50' },
    ]);
    assert.strictEqual(sql, "INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (6, 'Gizmo', 3.50)");
  });

  test('only includes columns the user actually filled in (sparse insert)', function () {
    const sql = buildInsertStatement('PRODUCTS', columns, [{ colIndex: 1, value: 'Gizmo' }]);
    assert.strictEqual(sql, "INSERT INTO PRODUCTS (NAME) VALUES ('Gizmo')");
  });

  test('writes NULL for a cell left as the NULL sentinel', function () {
    const sql = buildInsertStatement('PRODUCTS', columns, [{ colIndex: 1, value: NULL_SENTINEL }]);
    assert.ok(sql.includes('VALUES (NULL)'), sql);
  });

  test('throws when no values are provided', function () {
    assert.throws(() => buildInsertStatement('PRODUCTS', columns, []), /No values/);
  });

  test('rejects an invalid table name', function () {
    assert.throws(() => buildInsertStatement('1BAD', columns, [{ colIndex: 0, value: '1' }]));
  });
});

suite('buildDeleteStatement', function () {
  const columns = ['ID', 'NAME', 'PRICE'];
  const originalRow = ['1', 'Widget A', '9.99'];

  test('builds a DELETE targeted by primary key', function () {
    const sql = buildDeleteStatement('PRODUCTS', columns, originalRow, ['ID']);
    assert.strictEqual(sql, 'DELETE FROM PRODUCTS WHERE ID = 1');
  });

  test('falls back to matching every column when there is no primary key', function () {
    const sql = buildDeleteStatement('PRODUCTS', columns, originalRow, []);
    assert.strictEqual(sql, "DELETE FROM PRODUCTS WHERE ID = 1 AND NAME = 'Widget A' AND PRICE = 9.99");
  });

  test('rejects an invalid table name', function () {
    assert.throws(() => buildDeleteStatement('T; DROP TABLE X', columns, originalRow, ['ID']));
  });
});

suite('buildStatementForChange', function () {
  const columns = ['ID', 'NAME', 'PRICE'];
  const originalRow = ['1', 'Widget A', '9.99'];

  test('dispatches an update change to buildUpdateStatement', function () {
    const change: RowChange = { type: 'update', originalRow, values: [{ colIndex: 1, value: 'Widget B' }] };
    const sql = buildStatementForChange('PRODUCTS', columns, ['ID'], change);
    assert.ok(sql.startsWith('UPDATE PRODUCTS'), sql);
  });

  test('dispatches an insert change to buildInsertStatement', function () {
    const change: RowChange = { type: 'insert', values: [{ colIndex: 1, value: 'Gizmo' }] };
    const sql = buildStatementForChange('PRODUCTS', columns, [], change);
    assert.ok(sql.startsWith('INSERT INTO PRODUCTS'), sql);
  });

  test('dispatches a delete change to buildDeleteStatement', function () {
    const change: RowChange = { type: 'delete', originalRow };
    const sql = buildStatementForChange('PRODUCTS', columns, ['ID'], change);
    assert.ok(sql.startsWith('DELETE FROM PRODUCTS'), sql);
  });

  test('throws for an update change missing originalRow', function () {
    const change = { type: 'update', values: [{ colIndex: 1, value: 'x' }] } as RowChange;
    assert.throws(() => buildStatementForChange('PRODUCTS', columns, ['ID'], change), /requires both originalRow and values/);
  });

  test('throws for an update change missing values', function () {
    const change = { type: 'update', originalRow } as RowChange;
    assert.throws(() => buildStatementForChange('PRODUCTS', columns, ['ID'], change), /requires both originalRow and values/);
  });

  test('throws for an insert change missing values', function () {
    const change = { type: 'insert' } as RowChange;
    assert.throws(() => buildStatementForChange('PRODUCTS', columns, [], change), /requires values/);
  });

  test('throws for a delete change missing originalRow', function () {
    const change = { type: 'delete' } as RowChange;
    assert.throws(() => buildStatementForChange('PRODUCTS', columns, ['ID'], change), /requires originalRow/);
  });
});

suite('assertValidIdentifier() — two-part names (docs/roadmap/firebird6-schemas.md)', function () {
  test('accepts a schema-qualified name, which Firebird 6 tables outside PUBLIC require', function () {
    assert.doesNotThrow(() => assertValidIdentifier('SALES.ORDERS', 'table name'));
    assert.doesNotThrow(() => assertValidIdentifier('ORDERS', 'table name'));
  });

  test('still rejects everything unsafe, in either half', function () {
    // The point of this guard is that these builders interpolate the name straight into SQL.
    for (const bad of [
      "ORDERS; DROP TABLE T",
      "SALES.ORDERS; DROP TABLE T",
      "SALES.ORDERS'",
      "'SALES'.ORDERS",
      "SALES ORDERS",
      "SALES.ORDERS EXTRA",
    ]) {
      assert.throws(() => assertValidIdentifier(bad, 'table name'), `expected "${bad}" to be rejected`);
    }
  });

  test('rejects more than two parts, and empty halves', function () {
    assert.throws(() => assertValidIdentifier('A.B.C', 'table name'));
    assert.throws(() => assertValidIdentifier('.ORDERS', 'table name'));
    assert.throws(() => assertValidIdentifier('SALES.', 'table name'));
    assert.throws(() => assertValidIdentifier('', 'table name'));
  });
});

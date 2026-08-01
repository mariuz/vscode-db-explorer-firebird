/**
 * Firebird 6 SQL schema helpers — see docs/roadmap/firebird6-schemas.md.
 *
 * The behaviour worth pinning down here is the *asymmetry* between what is shown and what is put
 * in SQL: the tree hides a redundant `PUBLIC.` prefix, while generated SQL always qualifies, so an
 * action can never be resolved by the session's search path onto the wrong same-named table.
 */

import * as assert from 'assert';
import {
  supportsSchemas,
  schemaDisplayName,
  schemaQualifiedName,
  splitQualifiedName,
  DEFAULT_SCHEMA,
} from '../shared/schema-support';

suite('supportsSchemas()', function () {
  test('Firebird 6 is the first version with schemas', function () {
    assert.strictEqual(supportsSchemas(6), true);
    assert.strictEqual(supportsSchemas(7), true);
  });

  test('every earlier version, including an undetectable one, is treated as schema-less', function () {
    // 0 is what the version probe returns when it fails. It must mean "assume the oldest
    // behaviour": emitting RDB$SCHEMA_NAME against a pre-6 server is a hard SQL error.
    assert.strictEqual(supportsSchemas(0), false);
    assert.strictEqual(supportsSchemas(3), false);
    assert.strictEqual(supportsSchemas(5), false);
  });
});

suite('schemaDisplayName() — what the tree shows', function () {
  test('no schema at all (pre-Firebird 6) is the bare name', function () {
    assert.strictEqual(schemaDisplayName(undefined, 'ORDERS'), 'ORDERS');
  });

  test('the default schema is not shown, so a single-schema database looks unchanged', function () {
    assert.strictEqual(schemaDisplayName(DEFAULT_SCHEMA, 'ORDERS'), 'ORDERS');
  });

  test('any other schema is shown, because that is what tells two same-named tables apart', function () {
    assert.strictEqual(schemaDisplayName('SALES', 'ORDERS'), 'SALES.ORDERS');
  });

  test('trims the padding Firebird returns on CHAR metadata columns', function () {
    assert.strictEqual(schemaDisplayName('SALES   ', 'ORDERS   '), 'SALES.ORDERS');
    assert.strictEqual(schemaDisplayName('PUBLIC  ', 'ORDERS  '), 'ORDERS');
  });

  test('honours a non-PUBLIC default, since PUBLIC can be dropped by the database owner', function () {
    assert.strictEqual(schemaDisplayName('APP', 'ORDERS', 'APP'), 'ORDERS');
    assert.strictEqual(schemaDisplayName('PUBLIC', 'ORDERS', 'APP'), 'PUBLIC.ORDERS');
  });
});

suite('schemaQualifiedName() — what goes into SQL', function () {
  test('qualifies even the default schema, unlike the display name', function () {
    assert.strictEqual(schemaQualifiedName(DEFAULT_SCHEMA, 'ORDERS'), 'PUBLIC.ORDERS');
    assert.strictEqual(schemaQualifiedName('SALES', 'ORDERS'), 'SALES.ORDERS');
  });

  test('falls back to the bare name when there is no schema, keeping pre-6 SQL identical', function () {
    assert.strictEqual(schemaQualifiedName(undefined, 'ORDERS'), 'ORDERS');
    assert.strictEqual(schemaQualifiedName('', 'ORDERS'), 'ORDERS');
  });
});

suite('splitQualifiedName()', function () {
  test('round-trips what schemaQualifiedName() produces', function () {
    assert.deepStrictEqual(splitQualifiedName('SALES.ORDERS'), { schema: 'SALES', name: 'ORDERS' });
  });

  test('tolerates an unqualified name', function () {
    assert.deepStrictEqual(splitQualifiedName('ORDERS'), { name: 'ORDERS' });
  });

  test('does not treat a leading or trailing dot as a schema separator', function () {
    assert.deepStrictEqual(splitQualifiedName('.ORDERS'), { name: '.ORDERS' });
    assert.deepStrictEqual(splitQualifiedName('ORDERS.'), { name: 'ORDERS.' });
  });
});

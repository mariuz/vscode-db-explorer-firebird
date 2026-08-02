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
  connectionSearchPath,
  parseSearchPath,
  effectiveSearchPath,
  searchPathRank,
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

suite('connectionSearchPath() — what the attach actually sends', function () {
  test('no configured schema means no search path at all, not PUBLIC', function () {
    // "" is not the same as ["PUBLIC"]: the first leaves the server's own default alone.
    assert.deepStrictEqual(connectionSearchPath(undefined), []);
    assert.deepStrictEqual(connectionSearchPath('   '), []);
  });

  test('a non-default schema keeps PUBLIC behind it as a fallback', function () {
    // Mirrors node-firebird's buildSchemaSearchPath(), which is what reaches the wire.
    assert.deepStrictEqual(connectionSearchPath('SALES'), ['SALES', 'PUBLIC']);
  });

  test('PUBLIC itself is not repeated', function () {
    assert.deepStrictEqual(connectionSearchPath('PUBLIC'), ['PUBLIC']);
  });
});

suite('parseSearchPath()', function () {
  test('reads the schemas out of a SET SEARCH_PATH statement', function () {
    assert.deepStrictEqual(parseSearchPath('SET SEARCH_PATH TO SALES;'), ['SALES']);
    assert.deepStrictEqual(parseSearchPath('set search_path to sales, public;'), ['sales', 'public']);
  });

  test('the last statement wins, because that is what the session ends up with', function () {
    const sql = 'SET SEARCH_PATH TO SALES;\nSELECT * FROM ORDERS;\nSET SEARCH_PATH TO HR;\n';
    assert.deepStrictEqual(parseSearchPath(sql), ['HR']);
  });

  test('strips the quotes off a quoted identifier', function () {
    assert.deepStrictEqual(parseSearchPath('SET SEARCH_PATH TO "MySchema", PUBLIC;'), ['MySchema', 'PUBLIC']);
  });

  test('is undefined when the document says nothing, so the connection default stands', function () {
    assert.strictEqual(parseSearchPath('SELECT * FROM ORDERS;'), undefined);
    assert.strictEqual(parseSearchPath(''), undefined);
  });

  test('a statement with no schemas after it does not read as an empty path', function () {
    assert.strictEqual(parseSearchPath('SET SEARCH_PATH TO ;'), undefined);
  });

  test('terminates at the statement, not at the end of the document', function () {
    assert.deepStrictEqual(parseSearchPath('SET SEARCH_PATH TO SALES;\nSELECT 1 FROM RDB$DATABASE;'), ['SALES']);
  });
});

suite('effectiveSearchPath() — document over connection over default', function () {
  test('a SET SEARCH_PATH in the document overrides the connection it was opened with', function () {
    // The statement executes after the attach, so it is what the rest of the session sees.
    assert.deepStrictEqual(effectiveSearchPath('SET SEARCH_PATH TO HR;', ['SALES', 'PUBLIC']), ['HR']);
  });

  test('falls back to the connection when the document says nothing', function () {
    assert.deepStrictEqual(effectiveSearchPath('SELECT 1;', ['SALES', 'PUBLIC']), ['SALES', 'PUBLIC']);
  });

  test('falls back to Firebird own default when neither says anything', function () {
    assert.deepStrictEqual(effectiveSearchPath('SELECT 1;'), [DEFAULT_SCHEMA]);
    assert.deepStrictEqual(effectiveSearchPath('SELECT 1;', []), [DEFAULT_SCHEMA]);
  });

  test('does not hand back the caller own array to mutate', function () {
    const connection = ['SALES', 'PUBLIC'];
    const result = effectiveSearchPath('SELECT 1;', connection);
    result.push('HR');
    assert.deepStrictEqual(connection, ['SALES', 'PUBLIC']);
  });
});

suite('searchPathRank()', function () {
  test('ranks by position in the path, so the first entry wins', function () {
    assert.strictEqual(searchPathRank('SALES', ['SALES', 'PUBLIC']), 0);
    assert.strictEqual(searchPathRank('PUBLIC', ['SALES', 'PUBLIC']), 1);
  });

  test('anything off the path sorts after everything on it', function () {
    assert.strictEqual(searchPathRank('HR', ['SALES', 'PUBLIC']), 2);
  });

  test('is case-insensitive, since unquoted identifiers reach the server upper-cased', function () {
    assert.strictEqual(searchPathRank('SALES', ['sales', 'public']), 0);
    assert.strictEqual(searchPathRank(' sales ', ['SALES']), 0);
  });

  test('an unknown schema is treated as off the path rather than as the first entry', function () {
    assert.strictEqual(searchPathRank(undefined, ['SALES', 'PUBLIC']), 2);
    assert.strictEqual(searchPathRank('', ['SALES', 'PUBLIC']), 2);
  });
});

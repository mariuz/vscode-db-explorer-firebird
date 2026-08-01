/**
 * Go to Definition for SQL identifiers — see docs/roadmap/sql-language-features.md.
 */

import * as assert from 'assert';
import { DDL_SCHEME, ddlDocumentPath, objectNameFromDdlPath, findTableName } from '../language-server/definition-model';

const schema: any = {
  reservedKeywords: false,
  path: '',
  tables: [
    { name: 'CUSTOMERS', fields: [] },
    { name: 'RDB$RELATIONS', fields: [] },
  ],
};

suite('DDL document URIs', function () {
  test('the path ends in .sql so the document opens as SQL', function () {
    assert.strictEqual(ddlDocumentPath('CUSTOMERS'), 'CUSTOMERS.sql');
  });

  test('round-trips, including the leading slash VS Code adds to URI paths', function () {
    assert.strictEqual(objectNameFromDdlPath(ddlDocumentPath('CUSTOMERS')), 'CUSTOMERS');
    assert.strictEqual(objectNameFromDdlPath('/CUSTOMERS.sql'), 'CUSTOMERS');
  });

  test('round-trips a name containing $, which every system object has', function () {
    assert.strictEqual(objectNameFromDdlPath(ddlDocumentPath('RDB$RELATIONS')), 'RDB$RELATIONS');
  });

  test('the scheme is stable — it is baked into every URI already opened', function () {
    assert.strictEqual(DDL_SCHEME, 'firebird-ddl');
  });
});

suite('findTableName()', function () {
  test('resolves a known table', function () {
    assert.strictEqual(findTableName('CUSTOMERS', schema), 'CUSTOMERS');
  });

  test('returns the cached spelling, not what the user typed', function () {
    // Both must map to one URI, or F12 on `customers` and on `CUSTOMERS` would open two editors
    // showing the same table.
    assert.strictEqual(findTableName('customers', schema), 'CUSTOMERS');
    assert.strictEqual(findTableName('CuStOmErS', schema), 'CUSTOMERS');
  });

  test('returns nothing for a word that is not a table', function () {
    // Keywords and aliases must not offer a definition.
    assert.strictEqual(findTableName('SELECT', schema), undefined);
    assert.strictEqual(findTableName('', schema), undefined);
  });

  test('tolerates a schema with no tables', function () {
    assert.strictEqual(findTableName('CUSTOMERS', { tables: [] } as any), undefined);
  });
});

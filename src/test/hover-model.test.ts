/**
 * Hover content for SQL identifiers — see docs/roadmap/sql-language-features.md.
 */

import * as assert from 'assert';
import { identifierAt, buildHoverMarkdown } from '../language-server/hover-model';

const schema: any = {
  reservedKeywords: false,
  path: '',
  tables: [
    { name: 'CUSTOMERS', fields: [{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }] },
    { name: 'ORDERS', fields: [{ name: 'ID', type: 'INTEGER' }, { name: 'TOTAL', type: 'NUMERIC' }] },
    { name: 'RDB$RELATIONS', fields: [] },
  ],
};

suite('identifierAt()', function () {
  test('finds the word the cursor is inside', function () {
    assert.strictEqual(identifierAt('SELECT * FROM CUSTOMERS', 16), 'CUSTOMERS');
  });

  test('finds the word the cursor sits just past the end of', function () {
    // Hovering the last character of a word puts the cursor at its end offset.
    assert.strictEqual(identifierAt('SELECT * FROM CUSTOMERS', 23), 'CUSTOMERS');
  });

  test('returns nothing when the cursor is surrounded by non-identifier characters', function () {
    // Index 7 is the `*`, index 8 the space after it — neither adjoins a word.
    assert.strictEqual(identifierAt('SELECT * FROM CUSTOMERS', 7), undefined);
    assert.strictEqual(identifierAt('SELECT * FROM CUSTOMERS', 8), undefined);
  });

  test('a cursor immediately after a word still belongs to it', function () {
    // Index 6 is the space after SELECT, but positions sit *between* characters, so this is also
    // "the end of SELECT" — the same rule VS Code's own getWordRangeAtPosition() applies.
    assert.strictEqual(identifierAt('SELECT * FROM CUSTOMERS', 6), 'SELECT');
  });

  test('treats $ as part of an identifier, so system objects resolve', function () {
    // Every Firebird system object is RDB$… or MON$…; splitting on the $ would break all of them.
    assert.strictEqual(identifierAt('SELECT * FROM RDB$RELATIONS', 20), 'RDB$RELATIONS');
  });

  test('a qualified reference yields whichever half the cursor is on', function () {
    assert.strictEqual(identifierAt('SELECT C.NAME FROM CUSTOMERS C', 8), 'C');
    assert.strictEqual(identifierAt('SELECT C.NAME FROM CUSTOMERS C', 11), 'NAME');
  });

  test('is safe at the very start and end of a line', function () {
    assert.strictEqual(identifierAt('CUSTOMERS', 0), 'CUSTOMERS');
    assert.strictEqual(identifierAt('', 0), undefined);
    assert.strictEqual(identifierAt('ABC', 99), undefined);
  });
});

suite('buildHoverMarkdown()', function () {
  test('a table shows its columns and their types', function () {
    const md = buildHoverMarkdown('CUSTOMERS', schema)!;
    assert.ok(md.includes('**CUSTOMERS** — table'));
    assert.ok(md.includes('| ID | INTEGER |'));
    assert.ok(md.includes('| NAME | VARCHAR |'));
  });

  test('matches case-insensitively, since unquoted identifiers fold to upper case', function () {
    assert.ok(buildHoverMarkdown('customers', schema)!.includes('**CUSTOMERS**'));
  });

  test('a column names its type and its table', function () {
    const md = buildHoverMarkdown('TOTAL', schema)!;
    assert.ok(md.includes('**TOTAL**'));
    assert.ok(md.includes('NUMERIC'));
    assert.ok(md.includes('ORDERS'));
  });

  test('a column present in several tables lists all of them', function () {
    // Picking one arbitrarily would be actively misleading — ID exists in both.
    const md = buildHoverMarkdown('ID', schema)!;
    assert.ok(md.includes('CUSTOMERS'), md);
    assert.ok(md.includes('ORDERS'), md);
  });

  test('an unknown word produces no hover at all', function () {
    // Keywords and aliases must not get an invented "unknown object" popup.
    assert.strictEqual(buildHoverMarkdown('SELECT', schema), undefined);
    assert.strictEqual(buildHoverMarkdown('', schema), undefined);
  });

  test('a table with no cached columns says so rather than looking empty', function () {
    assert.ok(buildHoverMarkdown('RDB$RELATIONS', schema)!.includes('No columns known'));
  });

  test('tolerates a schema with no tables', function () {
    assert.strictEqual(buildHoverMarkdown('ANYTHING', { tables: [] } as any), undefined);
  });
});

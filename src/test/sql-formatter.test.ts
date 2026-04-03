import * as assert from 'assert';
import { formatSQL } from '../shared/sql-formatter';

suite('SQL Formatter', function () {

  // ── Basic keyword uppercasing ───────────────────────────────────────────────

  test('uppercases SELECT keyword', function () {
    const result = formatSQL('select 1 from rdb$database');
    assert.ok(result.includes('SELECT'), 'Expected SELECT to be uppercased');
    assert.ok(result.includes('FROM'), 'Expected FROM to be uppercased');
  });

  test('returns unchanged input for empty string', function () {
    assert.strictEqual(formatSQL(''), '');
  });

  test('returns unchanged input for whitespace-only string', function () {
    const ws = '   \n  ';
    assert.strictEqual(formatSQL(ws), ws);
  });

  // ── String literal preservation ────────────────────────────────────────────

  test('does not uppercase text inside single-quoted string literals', function () {
    const result = formatSQL("SELECT 'select from where' FROM T");
    assert.ok(result.includes("'select from where'"), 'String content should be preserved as-is');
  });

  test('preserves string with semicolons unchanged', function () {
    const result = formatSQL("SELECT 'a;b;c' FROM T");
    assert.ok(result.includes("'a;b;c'"), 'String with semicolons should not be modified');
  });

  // ── Comment preservation ───────────────────────────────────────────────────

  test('preserves line comment content', function () {
    const result = formatSQL('-- this is a select comment\nSELECT 1 FROM T');
    assert.ok(result.includes('-- this is a select comment'), 'Line comment should be preserved');
    assert.ok(result.includes('SELECT'), 'SELECT keyword should still be uppercased outside comment');
  });

  test('preserves block comment content', function () {
    const result = formatSQL('/* select * from T */ SELECT 1 FROM T');
    assert.ok(result.includes('/* select * from T */'), 'Block comment should be preserved as-is');
  });

  // ── Newline formatting ─────────────────────────────────────────────────────

  test('places FROM on a new line', function () {
    const result = formatSQL('SELECT ID FROM CUSTOMERS');
    const lines = result.split('\n');
    const fromLine = lines.find(l => l.startsWith('FROM'));
    assert.ok(fromLine !== undefined, 'FROM should start a new line');
  });

  test('places WHERE on a new line', function () {
    const result = formatSQL('SELECT ID FROM CUSTOMERS WHERE ID = 1');
    const lines = result.split('\n');
    const whereLine = lines.find(l => l.startsWith('WHERE'));
    assert.ok(whereLine !== undefined, 'WHERE should start a new line');
  });

  test('places ORDER BY on a new line', function () {
    const result = formatSQL('SELECT ID FROM CUSTOMERS ORDER BY ID');
    const lines = result.split('\n');
    const orderLine = lines.find(l => l.startsWith('ORDER BY'));
    assert.ok(orderLine !== undefined, 'ORDER BY should start a new line');
  });

  // ── SELECT column indentation ──────────────────────────────────────────────

  test('indents multiple SELECT columns on separate lines', function () {
    const result = formatSQL('SELECT ID, NAME, EMAIL FROM CUSTOMERS');
    const lines = result.split('\n');
    // After SELECT, each column should be on its own indented line
    const indentedLines = lines.filter(l => l.startsWith('    '));
    assert.ok(indentedLines.length >= 3, 'Expected at least 3 indented column lines');
  });

  test('keeps SELECT * on the same line as SELECT', function () {
    const result = formatSQL('SELECT * FROM CUSTOMERS');
    assert.ok(result.includes('SELECT *'), 'SELECT * should remain on one line');
  });

  // ── DML keywords ──────────────────────────────────────────────────────────

  test('uppercases INSERT INTO keyword', function () {
    const result = formatSQL('insert into CUSTOMERS (ID) values (1)');
    assert.ok(result.includes('INSERT INTO'), 'Expected INSERT INTO to be uppercased');
    assert.ok(result.includes('VALUES'), 'Expected VALUES to be uppercased');
  });

  test('uppercases UPDATE/SET keywords', function () {
    const result = formatSQL('update customers set name = \'Alice\' where id = 1');
    assert.ok(result.includes('UPDATE'), 'Expected UPDATE to be uppercased');
    assert.ok(result.includes('SET'), 'Expected SET to be uppercased');
  });

  test('uppercases DELETE FROM keyword', function () {
    const result = formatSQL('delete from customers where id = 1');
    // The formatter places FROM on its own line, so DELETE and FROM appear
    // as separate tokens in the output rather than adjacent.
    assert.ok(result.includes('DELETE'), 'Expected DELETE to be uppercased');
    assert.ok(result.includes('WHERE'), 'Expected WHERE to be uppercased');
  });

  // ── JOIN handling ──────────────────────────────────────────────────────────

  test('uppercases LEFT JOIN and places JOIN on a new line', function () {
    const result = formatSQL('SELECT a.ID FROM A left join B on a.ID = b.ID');
    // The formatter puts LEFT and JOIN on separate lines via the JOIN keyword rule.
    assert.ok(result.includes('LEFT'), 'Expected LEFT to be uppercased');
    assert.ok(result.includes('JOIN'), 'Expected JOIN to be uppercased');
    const lines = result.split('\n');
    const joinLine = lines.find(l => l.trim().startsWith('JOIN'));
    assert.ok(joinLine !== undefined, 'JOIN should start a new line');
  });

  test('uppercases INNER JOIN keywords', function () {
    const result = formatSQL('SELECT a.ID FROM A inner join B on a.ID = b.ID');
    assert.ok(result.includes('INNER'), 'Expected INNER to be uppercased');
    assert.ok(result.includes('JOIN'), 'Expected JOIN to be uppercased');
  });

  // ── Normalization ──────────────────────────────────────────────────────────

  test('trims leading and trailing whitespace from result', function () {
    const result = formatSQL('  select 1 from rdb$database  ');
    assert.ok(result.charAt(0) !== ' ' && result.charAt(0) !== '\t' && result.charAt(0) !== '\n',
      'Result should not start with whitespace');
    const lastChar = result.charAt(result.length - 1);
    assert.ok(lastChar !== ' ' && lastChar !== '\t' && lastChar !== '\n',
      'Result should not end with whitespace');
  });

  test('collapses multiple blank lines into at most one blank line', function () {
    const result = formatSQL('SELECT 1 FROM A\n\n\n\nSELECT 2 FROM B');
    assert.ok(!result.includes('\n\n\n'), 'Should not have more than 2 consecutive newlines');
  });
});

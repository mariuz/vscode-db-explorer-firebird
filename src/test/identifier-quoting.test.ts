import * as assert from 'assert';
import { quoteIdentifierIfNeeded } from '../shared/identifier-quoting';

suite('quoteIdentifierIfNeeded() (docs/roadmap/drag-identifier-into-editor.md, phase 2)', function () {

  test('an all-uppercase simple identifier needs no quoting', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('PRODUCTS'), 'PRODUCTS');
  });

  test('an all-uppercase identifier with digits/underscore/$ needs no quoting', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('ORDER_ITEMS_2'), 'ORDER_ITEMS_2');
    assert.strictEqual(quoteIdentifierIfNeeded('COL$1'), 'COL$1');
  });

  test('a lowercase or mixed-case name is quoted (would otherwise fold to a different name)', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('products'), '"products"');
    assert.strictEqual(quoteIdentifierIfNeeded('OrderItems'), '"OrderItems"');
  });

  test('a name containing a space is quoted', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('Order Items'), '"Order Items"');
  });

  test('a name starting with a digit is quoted', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('1TABLE'), '"1TABLE"');
  });

  test('a name that collides with a reserved word is quoted even though it is otherwise a valid unquoted shape', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('ORDER'), '"ORDER"');
    assert.strictEqual(quoteIdentifierIfNeeded('SELECT'), '"SELECT"');
  });

  test('a reserved-word check is case-insensitive against the stored (uppercase) name', function () {
    // real Firebird object names for unquoted-created objects are already uppercase; this just
    // confirms the reserved-word set itself is compared consistently in uppercase
    assert.strictEqual(quoteIdentifierIfNeeded('GROUP'), '"GROUP"');
  });

  test('a literal double-quote in the name is escaped by doubling it', function () {
    assert.strictEqual(quoteIdentifierIfNeeded('WEIRD"NAME'), '"WEIRD""NAME"');
  });

  test('reserved words absent from the completion list are still quoted', function () {
    // firebird-reserved.ts is a completion list, not the reserved-word authority — these five are
    // real reserved words with no entry there, and were previously inserted unquoted.
    for (const word of ['OFFSET', 'ROW', 'BOOLEAN', 'OVER', 'WINDOW']) {
      assert.strictEqual(quoteIdentifierIfNeeded(word), `"${word}"`);
    }
  });

  test('a name that is a reserved word substring (not an exact match) is not quoted', function () {
    // "ORDERS" is not the reserved word "ORDER"
    assert.strictEqual(quoteIdentifierIfNeeded('ORDERS'), 'ORDERS');
  });
});

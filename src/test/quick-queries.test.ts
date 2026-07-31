import * as assert from 'assert';
import {
  applySelectedText,
  findBookmarkForSlot,
  parseQuickQueries,
  resolveQuickQuery,
  QUICK_QUERY_SLOT_COUNT,
  SELECTED_TEXT_PLACEHOLDER,
} from '../shared/quick-queries';

suite('parseQuickQueries() (docs/roadmap/quick-queries.md, phase 1)', function () {

  test('a non-array setting value (unset, object, string, null) parses to an empty list', function () {
    assert.deepStrictEqual(parseQuickQueries(undefined), []);
    assert.deepStrictEqual(parseQuickQueries(null), []);
    assert.deepStrictEqual(parseQuickQueries({}), []);
    assert.deepStrictEqual(parseQuickQueries('SELECT 1'), []);
  });

  test('the minimal entry is just {sql}: name falls back to the first line, action to "run"', function () {
    assert.deepStrictEqual(parseQuickQueries([{ sql: 'SELECT 1 FROM RDB$DATABASE' }]), [
      { name: 'SELECT 1 FROM RDB$DATABASE', sql: 'SELECT 1 FROM RDB$DATABASE', action: 'run' },
    ]);
  });

  test('a derived name uses only the first line, capped at 40 characters', function () {
    const [multiline] = parseQuickQueries([{ sql: '  SELECT A\nFROM T\nWHERE X = 1  ' }]);
    assert.strictEqual(multiline?.name, 'SELECT A');

    const long = 'SELECT COLUMN_ONE, COLUMN_TWO, COLUMN_THREE FROM SOME_TABLE';
    const [capped] = parseQuickQueries([{ sql: long }]);
    assert.strictEqual(capped?.name, 'SELECT COLUMN_ONE, COLUMN_TWO, COLUMN_T…');
    assert.strictEqual(capped?.name.length, 40);
    assert.strictEqual(capped?.sql, long, 'the sql itself must never be truncated');
  });

  test('an explicit name and action are kept; an unrecognized action falls back to "run"', function () {
    assert.deepStrictEqual(
      parseQuickQueries([
        { name: '  Row counts  ', sql: 'SELECT 1', action: 'open' },
        { name: 'Bad action', sql: 'SELECT 2', action: 'launch' },
      ]),
      [
        { name: 'Row counts', sql: 'SELECT 1', action: 'open' },
        { name: 'Bad action', sql: 'SELECT 2', action: 'run' },
      ]
    );
  });

  test('an unusable entry becomes null in place, so later slots keep their positions', function () {
    // The whole point of the null placeholder: a user with a typo in entry 2 must not have
    // entry 3 silently promoted into slot 2, repointing an already-bound keybinding.
    const slots = parseQuickQueries([
      { sql: 'SELECT 1' },
      { sql: '   ' },
      { name: 'no sql at all' },
      'not an object',
      null,
      ['nested array'],
      { sql: 'SELECT 7' },
    ]);
    assert.strictEqual(slots.length, 7);
    assert.strictEqual(slots[0]?.sql, 'SELECT 1');
    assert.deepStrictEqual(slots.slice(1, 6), [null, null, null, null, null]);
    assert.strictEqual(slots[6]?.sql, 'SELECT 7');
  });
});

suite('resolveQuickQuery()', function () {
  const slots = parseQuickQueries([{ sql: 'SELECT 1' }, { sql: '' }, { sql: 'SELECT 3' }]);

  test('resolves a 1-based slot number, not a 0-based index', function () {
    assert.strictEqual(resolveQuickQuery(slots, 1)?.sql, 'SELECT 1');
    assert.strictEqual(resolveQuickQuery(slots, 3)?.sql, 'SELECT 3');
  });

  test('an unusable slot resolves to undefined rather than the next usable one', function () {
    assert.strictEqual(resolveQuickQuery(slots, 2), undefined);
  });

  test('out-of-range, zero, negative, and non-integer slots resolve to undefined', function () {
    assert.strictEqual(resolveQuickQuery(slots, 0), undefined);
    assert.strictEqual(resolveQuickQuery(slots, -1), undefined);
    assert.strictEqual(resolveQuickQuery(slots, 4), undefined);
    assert.strictEqual(resolveQuickQuery(slots, 1.5), undefined);
    assert.strictEqual(resolveQuickQuery([], 1), undefined);
  });

  test('entries past the contributed command count parse but are simply unreachable', function () {
    const many = parseQuickQueries(
      Array.from({ length: QUICK_QUERY_SLOT_COUNT + 2 }, (_unused, i) => ({ sql: `SELECT ${i + 1}` }))
    );
    assert.strictEqual(resolveQuickQuery(many, QUICK_QUERY_SLOT_COUNT)?.sql, `SELECT ${QUICK_QUERY_SLOT_COUNT}`);
    // Parsed (so a mistake stays visible), but no firebird.quickQuery.10 command exists to run it.
    assert.strictEqual(many.length, QUICK_QUERY_SLOT_COUNT + 2);
  });
});

suite('findBookmarkForSlot()', function () {
  const bookmarks = [
    { name: 'Unbound', sql: 'SELECT 1' },
    { name: 'Slot two', sql: 'SELECT 2', slot: 2 },
    { name: 'Slot five', sql: 'SELECT 5', slot: 5 },
  ];

  test('finds the bookmark bound to a slot, and nothing for an unbound slot', function () {
    assert.strictEqual(findBookmarkForSlot(bookmarks, 2)?.name, 'Slot two');
    assert.strictEqual(findBookmarkForSlot(bookmarks, 5)?.name, 'Slot five');
    assert.strictEqual(findBookmarkForSlot(bookmarks, 1), undefined);
  });

  test('a bookmark with no slot is never matched, including by an undefined-ish lookup', function () {
    assert.strictEqual(findBookmarkForSlot(bookmarks, 0), undefined);
    assert.strictEqual(findBookmarkForSlot(bookmarks, NaN), undefined);
    assert.strictEqual(findBookmarkForSlot([], 1), undefined);
  });

  test('when two bookmarks claim one slot the first wins, so resolution is order-stable', function () {
    const duplicated = [
      { name: 'First claim', sql: 'SELECT 1', slot: 3 },
      { name: 'Second claim', sql: 'SELECT 2', slot: 3 },
    ];
    assert.strictEqual(findBookmarkForSlot(duplicated, 3)?.name, 'First claim');
  });
});

suite('applySelectedText() (docs/roadmap/quick-queries.md, phase 2)', function () {

  test('a query without the placeholder is returned unchanged, whatever the selection is', function () {
    const sql = 'SELECT COUNT(*) FROM PRODUCTS';
    assert.deepStrictEqual(applySelectedText(sql, undefined), { ok: true, sql });
    assert.deepStrictEqual(applySelectedText(sql, 'IGNORED'), { ok: true, sql });
  });

  test('the placeholder is replaced with the selection, trimmed', function () {
    const result = applySelectedText(`SELECT COUNT(*) FROM ${SELECTED_TEXT_PLACEHOLDER}`, '  PRODUCTS\n');
    assert.deepStrictEqual(result, { ok: true, sql: 'SELECT COUNT(*) FROM PRODUCTS' });
  });

  test('every occurrence of the placeholder is replaced, not just the first', function () {
    const result = applySelectedText(
      `SELECT * FROM ${SELECTED_TEXT_PLACEHOLDER} WHERE ID NOT IN (SELECT ID FROM ${SELECTED_TEXT_PLACEHOLDER}_ARCHIVE)`,
      'ORDERS'
    );
    assert.deepStrictEqual(result, {
      ok: true,
      sql: 'SELECT * FROM ORDERS WHERE ID NOT IN (SELECT ID FROM ORDERS_ARCHIVE)',
    });
  });

  test('a "$"-bearing selection is inserted literally, not treated as a replacement pattern', function () {
    // String.replace() would expand $& / $` / $1 inside the replacement; split/join must not.
    const result = applySelectedText(`SELECT * FROM ${SELECTED_TEXT_PLACEHOLDER}`, 'RDB$RELATIONS');
    assert.deepStrictEqual(result, { ok: true, sql: 'SELECT * FROM RDB$RELATIONS' });

    const patternish = applySelectedText(`SELECT ${SELECTED_TEXT_PLACEHOLDER}`, '$& $` $1');
    assert.deepStrictEqual(patternish, { ok: true, sql: 'SELECT $& $` $1' });
  });

  test('the placeholder with no selection is refused, not substituted with an empty string', function () {
    for (const selection of [undefined, '', '   \n\t ']) {
      const result = applySelectedText(`SELECT COUNT(*) FROM ${SELECTED_TEXT_PLACEHOLDER}`, selection);
      assert.strictEqual(result.ok, false, `expected refusal for ${JSON.stringify(selection)}`);
      if (!result.ok) {
        assert.ok(result.reason.includes(SELECTED_TEXT_PLACEHOLDER), result.reason);
      }
    }
  });
});

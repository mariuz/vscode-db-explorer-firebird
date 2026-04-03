/**
 * Unit tests for BookmarkProvider.
 *
 * The BookmarkProvider uses the vscode API (EventEmitter, TreeItem, ThemeIcon).
 * These are replaced by our minimal mock via src/test/setup.ts.
 */

import * as assert from 'assert';
import { BookmarkProvider, BookmarkItem } from '../bookmarks/bookmark-provider';
import { createMockContext } from './mocks/vscode';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider() {
  const ctx = createMockContext() as any;
  const provider = new BookmarkProvider(ctx);
  return { provider, ctx };
}

// ── getAll / initial state ─────────────────────────────────────────────────────

suite('BookmarkProvider – getAll', function () {

  test('returns empty array when no bookmarks have been saved', function () {
    const { provider } = makeProvider();
    assert.deepStrictEqual(provider.getAll(), []);
  });
});

// ── getChildren ────────────────────────────────────────────────────────────────

suite('BookmarkProvider – getChildren', function () {

  test('returns single EmptyBookmarkItem when there are no bookmarks', function () {
    const { provider } = makeProvider();
    const children = provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual((children[0] as any).contextValue, 'empty');
  });

  test('returns BookmarkItem list when bookmarks exist', async function () {
    const { provider } = makeProvider();
    await provider.add('My Query', 'SELECT 1 FROM RDB$DATABASE');
    const children = provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof BookmarkItem, 'Expected BookmarkItem');
  });

  test('each BookmarkItem has correct contextValue', async function () {
    const { provider } = makeProvider();
    await provider.add('Q1', 'SELECT 1 FROM RDB$DATABASE');
    const children = provider.getChildren();
    assert.strictEqual((children[0] as BookmarkItem).contextValue, 'bookmark');
  });
});

// ── add ────────────────────────────────────────────────────────────────────────

suite('BookmarkProvider – add', function () {

  test('adds a bookmark and getAll returns it', async function () {
    const { provider } = makeProvider();
    await provider.add('Test Bookmark', 'SELECT * FROM CUSTOMERS');
    const all = provider.getAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].name, 'Test Bookmark');
    assert.strictEqual(all[0].sql, 'SELECT * FROM CUSTOMERS');
  });

  test('added bookmark has a non-empty id', async function () {
    const { provider } = makeProvider();
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    const all = provider.getAll();
    assert.ok(all[0].id && all[0].id.length > 0, 'Bookmark should have a non-empty id');
  });

  test('added bookmark has an ISO createdAt date', async function () {
    const { provider } = makeProvider();
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    const all = provider.getAll();
    const date = new Date(all[0].createdAt);
    assert.ok(!isNaN(date.getTime()), 'createdAt should be a valid ISO date string');
  });

  test('multiple bookmarks accumulate', async function () {
    const { provider } = makeProvider();
    await provider.add('Q1', 'SELECT 1 FROM RDB$DATABASE');
    await provider.add('Q2', 'SELECT 2 FROM RDB$DATABASE');
    await provider.add('Q3', 'SELECT 3 FROM RDB$DATABASE');
    assert.strictEqual(provider.getAll().length, 3);
  });

  test('fires onDidChangeTreeData after add', async function () {
    const { provider } = makeProvider();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    assert.ok(fired, 'onDidChangeTreeData should fire after add');
  });
});

// ── delete ─────────────────────────────────────────────────────────────────────

suite('BookmarkProvider – delete', function () {

  test('deletes an existing bookmark by id', async function () {
    const { provider } = makeProvider();
    await provider.add('ToDelete', 'SELECT 1 FROM RDB$DATABASE');
    const id = provider.getAll()[0].id;
    await provider.delete(id);
    assert.strictEqual(provider.getAll().length, 0);
  });

  test('does not affect other bookmarks when deleting one', async function () {
    const { provider } = makeProvider();
    await provider.add('Keep', 'SELECT 1 FROM RDB$DATABASE');
    await provider.add('Remove', 'SELECT 2 FROM RDB$DATABASE');
    const removeId = provider.getAll().find(b => b.name === 'Remove')!.id;
    await provider.delete(removeId);
    const remaining = provider.getAll();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].name, 'Keep');
  });

  test('delete with unknown id leaves all bookmarks intact', async function () {
    const { provider } = makeProvider();
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    await provider.delete('nonexistent-id');
    assert.strictEqual(provider.getAll().length, 1);
  });

  test('fires onDidChangeTreeData after delete', async function () {
    const { provider } = makeProvider();
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    const id = provider.getAll()[0].id;
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.delete(id);
    assert.ok(fired, 'onDidChangeTreeData should fire after delete');
  });
});

// ── rename ─────────────────────────────────────────────────────────────────────

suite('BookmarkProvider – rename', function () {

  test('renames an existing bookmark', async function () {
    const { provider } = makeProvider();
    await provider.add('Old Name', 'SELECT 1 FROM RDB$DATABASE');
    const id = provider.getAll()[0].id;
    await provider.rename(id, 'New Name');
    assert.strictEqual(provider.getAll()[0].name, 'New Name');
  });

  test('does not change the sql when renaming', async function () {
    const { provider } = makeProvider();
    await provider.add('Old', 'SELECT 1 FROM RDB$DATABASE');
    const id = provider.getAll()[0].id;
    await provider.rename(id, 'New');
    assert.strictEqual(provider.getAll()[0].sql, 'SELECT 1 FROM RDB$DATABASE');
  });

  test('rename with unknown id leaves bookmarks unchanged', async function () {
    const { provider } = makeProvider();
    await provider.add('Keep', 'SELECT 1 FROM RDB$DATABASE');
    await provider.rename('no-such-id', 'Ghost');
    assert.strictEqual(provider.getAll()[0].name, 'Keep');
  });

  test('fires onDidChangeTreeData after rename', async function () {
    const { provider } = makeProvider();
    await provider.add('Q', 'SELECT 1 FROM RDB$DATABASE');
    const id = provider.getAll()[0].id;
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.rename(id, 'New Q');
    assert.ok(fired, 'onDidChangeTreeData should fire after rename');
  });
});

// ── BookmarkItem ───────────────────────────────────────────────────────────────

suite('BookmarkItem', function () {

  test('label matches bookmark name', function () {
    const bm = { id: '1', name: 'My Query', sql: 'SELECT 1', createdAt: new Date().toISOString() };
    const item = new BookmarkItem(bm);
    assert.strictEqual(item.label, 'My Query');
  });

  test('tooltip is the SQL for short queries', function () {
    const bm = { id: '1', name: 'Q', sql: 'SELECT 1 FROM RDB$DATABASE', createdAt: new Date().toISOString() };
    const item = new BookmarkItem(bm);
    assert.strictEqual(item.tooltip, bm.sql);
  });

  test('tooltip is truncated with ellipsis for long SQL (>200 chars)', function () {
    const longSql = 'SELECT ' + 'A, '.repeat(70) + 'B FROM T';
    const bm = { id: '1', name: 'Long', sql: longSql, createdAt: new Date().toISOString() };
    const item = new BookmarkItem(bm);
    assert.ok((item.tooltip as string).endsWith('…'), 'Tooltip should end with ellipsis for long SQL');
    assert.ok((item.tooltip as string).length <= 201, 'Tooltip should be truncated');
  });

  test('contextValue is "bookmark"', function () {
    const bm = { id: '1', name: 'Q', sql: 'SELECT 1', createdAt: new Date().toISOString() };
    const item = new BookmarkItem(bm);
    assert.strictEqual(item.contextValue, 'bookmark');
  });

  test('command is firebird.bookmarks.open', function () {
    const bm = { id: '1', name: 'Q', sql: 'SELECT 1', createdAt: new Date().toISOString() };
    const item = new BookmarkItem(bm);
    assert.strictEqual((item.command as any).command, 'firebird.bookmarks.open');
  });
});

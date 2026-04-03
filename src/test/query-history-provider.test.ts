/**
 * Unit tests for QueryHistoryProvider.
 *
 * The QueryHistoryProvider uses the vscode API (EventEmitter, TreeItem).
 * These are replaced by our minimal mock via src/test/setup.ts.
 */

import * as assert from 'assert';
import { QueryHistoryProvider, QueryHistoryItem, HistoryEntry } from '../query-history/query-history-provider';
import { createMockContext } from './mocks/vscode';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider() {
  const ctx = createMockContext() as any;
  const provider = new QueryHistoryProvider(ctx);
  return { provider, ctx };
}

function entry(sql: string, opts: Partial<Omit<HistoryEntry, 'id' | 'executedAt' | 'sql'>> = {}) {
  return { sql, ...opts };
}

// ── getEntries / initial state ─────────────────────────────────────────────────

suite('QueryHistoryProvider – getEntries', function () {

  test('returns empty array when no history exists', function () {
    const { provider } = makeProvider();
    assert.deepStrictEqual(provider.getEntries(), []);
  });
});

// ── add ────────────────────────────────────────────────────────────────────────

suite('QueryHistoryProvider – add', function () {

  test('adds an entry and getEntries returns it', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    const entries = provider.getEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].sql, 'SELECT 1 FROM RDB$DATABASE');
  });

  test('new entries are prepended (most recent first)', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    await provider.add(entry('SELECT 2 FROM RDB$DATABASE'));
    const entries = provider.getEntries();
    assert.strictEqual(entries[0].sql, 'SELECT 2 FROM RDB$DATABASE');
    assert.strictEqual(entries[1].sql, 'SELECT 1 FROM RDB$DATABASE');
  });

  test('added entry has a non-empty id', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    const e = provider.getEntries()[0];
    assert.ok(e.id && e.id.length > 0, 'Entry should have non-empty id');
  });

  test('added entry has an ISO executedAt timestamp', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    const e = provider.getEntries()[0];
    const d = new Date(e.executedAt);
    assert.ok(!isNaN(d.getTime()), 'executedAt should be a valid ISO date string');
  });

  test('optional rowCount is persisted', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE', { rowCount: 42 }));
    assert.strictEqual(provider.getEntries()[0].rowCount, 42);
  });

  test('optional durationMs is persisted', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE', { durationMs: 120 }));
    assert.strictEqual(provider.getEntries()[0].durationMs, 120);
  });

  test('optional error is persisted', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT BAD FROM NONEXISTENT', { error: 'Table not found' }));
    assert.strictEqual(provider.getEntries()[0].error, 'Table not found');
  });

  test('history is capped at 50 entries', async function () {
    const { provider } = makeProvider();
    for (let i = 0; i < 55; i++) {
      await provider.add(entry(`SELECT ${i} FROM RDB$DATABASE`));
    }
    assert.strictEqual(provider.getEntries().length, 50, 'History should be capped at 50 entries');
  });

  test('fires onDidChangeTreeData after add', async function () {
    const { provider } = makeProvider();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    assert.ok(fired, 'onDidChangeTreeData should fire after add');
  });
});

// ── delete ─────────────────────────────────────────────────────────────────────

suite('QueryHistoryProvider – delete', function () {

  test('removes an entry by id', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    const id = provider.getEntries()[0].id;
    await provider.delete(id);
    assert.strictEqual(provider.getEntries().length, 0);
  });

  test('does not affect other entries when deleting one', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    // Ensure distinct IDs by adding a tiny delay (Date.now() is used as id)
    await new Promise(resolve => setTimeout(resolve, 2));
    await provider.add(entry('SELECT 2 FROM RDB$DATABASE'));
    const all = provider.getEntries();
    const keepEntry = all.find(e => e.sql.includes('SELECT 1'))!;
    const removeEntry = all.find(e => e.sql.includes('SELECT 2'))!;
    await provider.delete(removeEntry.id);
    const remaining = provider.getEntries();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, keepEntry.id);
  });

  test('delete with unknown id leaves entries unchanged', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    await provider.delete('no-such-id');
    assert.strictEqual(provider.getEntries().length, 1);
  });

  test('fires onDidChangeTreeData after delete', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    const id = provider.getEntries()[0].id;
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.delete(id);
    assert.ok(fired, 'onDidChangeTreeData should fire after delete');
  });
});

// ── clear ──────────────────────────────────────────────────────────────────────

suite('QueryHistoryProvider – clear', function () {

  test('removes all entries', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    await provider.add(entry('SELECT 2 FROM RDB$DATABASE'));
    await provider.clear();
    assert.strictEqual(provider.getEntries().length, 0);
  });

  test('fires onDidChangeTreeData after clear', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    await provider.clear();
    assert.ok(fired, 'onDidChangeTreeData should fire after clear');
  });
});

// ── getChildren ────────────────────────────────────────────────────────────────

suite('QueryHistoryProvider – getChildren', function () {

  test('returns empty array when no history', function () {
    const { provider } = makeProvider();
    assert.deepStrictEqual(provider.getChildren(), []);
  });

  test('returns QueryHistoryItem for each entry', async function () {
    const { provider } = makeProvider();
    await provider.add(entry('SELECT 1 FROM RDB$DATABASE'));
    await provider.add(entry('SELECT 2 FROM RDB$DATABASE'));
    const children = provider.getChildren();
    assert.strictEqual(children.length, 2);
    assert.ok(children[0] instanceof QueryHistoryItem, 'Expected QueryHistoryItem');
  });
});

// ── QueryHistoryItem label ────────────────────────────────────────────────────

suite('QueryHistoryItem – label', function () {

  function makeEntry(sql: string, opts: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id: '1',
      sql,
      executedAt: new Date().toISOString(),
      ...opts,
    };
  }

  test('label is the SQL for short queries', function () {
    const e = makeEntry('SELECT 1 FROM RDB$DATABASE');
    const item = new QueryHistoryItem(e);
    assert.strictEqual(item.label, 'SELECT 1 FROM RDB$DATABASE');
  });

  test('label is truncated at 60 chars with ...', function () {
    const longSql = 'SELECT ' + 'A, '.repeat(25) + 'B FROM T';
    const e = makeEntry(longSql);
    const item = new QueryHistoryItem(e);
    assert.ok((item.label as string).length <= 60, 'Label should be at most 60 chars');
    assert.ok((item.label as string).endsWith('...'), 'Long label should end with ...');
  });

  test('label normalises whitespace', function () {
    const e = makeEntry('SELECT\n  1\n  FROM\n  RDB$DATABASE');
    const item = new QueryHistoryItem(e);
    assert.ok(!(item.label as string).includes('\n'), 'Label should not contain newlines');
  });

  test('tooltip is the full raw SQL', function () {
    const sql = 'SELECT\n  1\n  FROM\n  RDB$DATABASE';
    const e = makeEntry(sql);
    const item = new QueryHistoryItem(e);
    assert.strictEqual(item.tooltip, sql);
  });

  test('description shows error when entry has an error', function () {
    const e = makeEntry('SELECT 1 FROM RDB$DATABASE', { error: 'Table not found' });
    const item = new QueryHistoryItem(e);
    assert.ok((item.description as string).includes('error'), `Description should note error: ${item.description}`);
  });

  test('description includes row count when present', function () {
    const e = makeEntry('SELECT 1 FROM RDB$DATABASE', { rowCount: 5 });
    const item = new QueryHistoryItem(e);
    assert.ok((item.description as string).includes('5'), `Description should include row count: ${item.description}`);
  });

  test('contextValue is "historyEntry"', function () {
    const e = makeEntry('SELECT 1 FROM RDB$DATABASE');
    const item = new QueryHistoryItem(e);
    assert.strictEqual(item.contextValue, 'historyEntry');
  });

  test('command is firebird.history.open', function () {
    const e = makeEntry('SELECT 1 FROM RDB$DATABASE');
    const item = new QueryHistoryItem(e);
    assert.strictEqual((item.command as any).command, 'firebird.history.open');
  });
});

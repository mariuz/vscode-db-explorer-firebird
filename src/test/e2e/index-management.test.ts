/**
 * End-to-end coverage for index management: creates a real standalone index on the seeded
 * PRODUCTS table, confirms getIndexesQuery() (the exact query NodeIndexFolder uses) finds it with
 * the right columns/uniqueness, then drops it — and separately confirms PRODUCTS' own PRIMARY KEY
 * constraint index is correctly excluded, proving the constraint-backed-index filter works against
 * a real server's RDB$RELATION_CONSTRAINTS data, not just the shape asserted in unit tests.
 *
 * Same connection env vars as firebird-connection.test.ts:
 *   FIREBIRD_HOST / FIREBIRD_PORT / FIREBIRD_DATABASE / FIREBIRD_USER / FIREBIRD_PASSWORD
 */

import * as assert from 'assert';
import * as Firebird from 'node-firebird';
import { getE2EOptions } from './e2e-connection';
import { getIndexesQuery, createIndexQuery, dropIndexQuery } from '../../shared/queries';

const getOptions = getE2EOptions;

function attach(): Promise<Firebird.Database> {
  return new Promise<Firebird.Database>((resolve, reject) => {
    Firebird.attach(getOptions(), (err, db) => {
      if (err) { reject(err); } else { resolve(db); }
    });
  });
}

function query<T = any>(db: Firebird.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    db.query(sql, params, (err: any, rows: T[]) => {
      if (err) { reject(err); } else { resolve(rows); }
    });
  });
}

function detach(db: Firebird.Database): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    db.detach((err: any) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}

suite('E2E – Index management on the PRODUCTS table', function () {
  this.timeout(15000);

  let db: Firebird.Database;
  const indexName = 'FS_TEST_IDX_PRODUCTS_NAME';

  suiteSetup(async function () {
    db = await attach();
    try { await query(db, dropIndexQuery(indexName)); } catch { /* didn't exist yet */ }
  });

  suiteTeardown(async function () {
    if (db) {
      try { await query(db, dropIndexQuery(indexName)); } catch { /* already gone */ }
      await detach(db);
    }
  });

  test('createIndexQuery() creates a real index findable via getIndexesQuery()', async function () {
    await query(db, createIndexQuery(indexName, 'PRODUCTS', ['NAME'], false));

    const rows = await query<{ INDEX_NAME: string; IS_UNIQUE: number; COLUMNS: string }>(db, getIndexesQuery('PRODUCTS'));
    const match = rows.find(r => r.INDEX_NAME.trim() === indexName);
    assert.ok(match, `expected ${indexName} among: ${rows.map(r => r.INDEX_NAME.trim()).join(', ')}`);
    assert.strictEqual(match!.COLUMNS.trim(), 'NAME');
    assert.strictEqual(Number(match!.IS_UNIQUE), 0);
  });

  test('getIndexesQuery() excludes the PRIMARY KEY constraint index (PK_PRODUCTS)', async function () {
    const rows = await query<{ INDEX_NAME: string }>(db, getIndexesQuery('PRODUCTS'));
    const names = rows.map(r => r.INDEX_NAME.trim());
    assert.ok(!names.includes('PK_PRODUCTS'), `expected the PK-backed index excluded, got: ${names.join(', ')}`);
  });

  test('dropIndexQuery() actually removes the index', async function () {
    await query(db, dropIndexQuery(indexName));

    const rows = await query<{ INDEX_NAME: string }>(db, getIndexesQuery('PRODUCTS'));
    assert.ok(!rows.map(r => r.INDEX_NAME.trim()).includes(indexName));
  });

  test('createIndexQuery() with unique=true creates a real UNIQUE index', async function () {
    await query(db, createIndexQuery(indexName, 'PRODUCTS', ['NAME'], true));

    const rows = await query<{ INDEX_NAME: string; IS_UNIQUE: number }>(db, getIndexesQuery('PRODUCTS'));
    const match = rows.find(r => r.INDEX_NAME.trim() === indexName);
    assert.ok(match);
    assert.strictEqual(Number(match!.IS_UNIQUE), 1);
  });
});

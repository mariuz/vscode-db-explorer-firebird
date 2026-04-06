/**
 * End-to-end tests for Firebird database connectivity and query execution.
 *
 * These tests require a running Firebird server and a pre-created test database.
 * They are driven by the following environment variables (all optional with
 * sensible CI defaults):
 *
 *   FIREBIRD_HOST     – hostname / IP of the Firebird server (default: localhost)
 *   FIREBIRD_PORT     – TCP port                              (default: 3050)
 *   FIREBIRD_DATABASE – full path to the database file        (default: /firebird/data/test.fdb)
 *   FIREBIRD_USER     – database user                         (default: sysdba)
 *   FIREBIRD_PASSWORD – user password                         (default: masterkey)
 *
 * The GitHub Actions e2e workflow seeds the database with a PRODUCTS table and
 * sample rows before these tests run.
 */

import * as assert from 'assert';
import * as Firebird from 'node-firebird';

// ── Connection helpers ────────────────────────────────────────────────────────

function getOptions(): Firebird.Options {
  return {
    host:      process.env.FIREBIRD_HOST     ?? 'localhost',
    port:      Number(process.env.FIREBIRD_PORT ?? '3050'),
    database:  process.env.FIREBIRD_DATABASE ?? '/var/lib/firebird/data/test.fdb',
    user:      process.env.FIREBIRD_USER     ?? 'sysdba',
    password:  process.env.FIREBIRD_PASSWORD ?? 'masterkey',
    // Firebird 5 defaults to WireCrypt=Enabled; disable for CI test connections
    wireCrypt: Firebird.WIRE_CRYPT_DISABLE,
  };
}

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

// ── Connection ────────────────────────────────────────────────────────────────

suite('E2E – Firebird connection', function () {
  this.timeout(15000);

  test('can connect to and detach from the test database', async function () {
    const db = await attach();
    assert.ok(db, 'Expected a database handle');
    await detach(db);
  });
});

// ── Basic queries ─────────────────────────────────────────────────────────────

suite('E2E – Basic query execution', function () {
  this.timeout(15000);

  let db: Firebird.Database;

  setup(async function () {
    db = await attach();
  });

  teardown(async function () {
    if (db) { await detach(db); }
  });

  test('SELECT 1 returns a single row', async function () {
    const rows = await query(db, 'SELECT 1 AS VAL FROM RDB$DATABASE');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].VAL ?? rows[0].val), 1);
  });

  test('can query RDB$DATABASE system table', async function () {
    const rows = await query(db, 'SELECT RDB$DESCRIPTION FROM RDB$DATABASE');
    assert.ok(Array.isArray(rows), 'Expected an array of rows');
  });
});

// ── PRODUCTS table ────────────────────────────────────────────────────────────

suite('E2E – PRODUCTS table', function () {
  this.timeout(15000);

  let db: Firebird.Database;

  setup(async function () {
    db = await attach();
  });

  teardown(async function () {
    if (db) { await detach(db); }
  });

  test('PRODUCTS table exists and has the expected columns', async function () {
    const rows = await query(
      db,
      `SELECT TRIM(rf.RDB$FIELD_NAME) AS FIELD_NAME
         FROM RDB$RELATION_FIELDS rf
        WHERE TRIM(rf.RDB$RELATION_NAME) = 'PRODUCTS'
        ORDER BY rf.RDB$FIELD_POSITION`,
    );
    const cols = rows.map((r: any) => (r.FIELD_NAME ?? r.field_name ?? '').trim().toUpperCase());
    assert.ok(cols.includes('ID'),    'Expected ID column');
    assert.ok(cols.includes('NAME'),  'Expected NAME column');
    assert.ok(cols.includes('PRICE'), 'Expected PRICE column');
  });

  test('PRODUCTS table has seeded rows', async function () {
    const rows = await query(db, 'SELECT COUNT(*) AS CNT FROM PRODUCTS');
    const count = Number(rows[0].CNT ?? rows[0].cnt ?? 0);
    assert.ok(count >= 3, `Expected at least 3 seeded rows, got ${count}`);
  });

  test('can SELECT rows from PRODUCTS', async function () {
    const rows = await query(db, 'SELECT ID, NAME, PRICE FROM PRODUCTS ORDER BY ID');
    assert.ok(rows.length >= 3, 'Expected at least 3 rows');
    const first: any = rows[0];
    assert.ok(first.ID !== undefined || first.id !== undefined, 'Expected ID field');
    assert.ok(first.NAME !== undefined || first.name !== undefined, 'Expected NAME field');
  });

  test('parameterised query filters rows correctly', async function () {
    const rows = await query(db, 'SELECT ID, NAME FROM PRODUCTS WHERE ID = ?', [1]);
    assert.strictEqual(rows.length, 1, 'Expected exactly one row for ID=1');
  });

  test('INSERT, SELECT, and DELETE round-trip', async function () {
    // Insert a temporary row
    await query(db, "INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (999, 'TestProduct', 0.01)");

    const inserted = await query(db, 'SELECT NAME FROM PRODUCTS WHERE ID = 999');
    const name: string = (inserted[0].NAME ?? inserted[0].name ?? '').trim();
    assert.strictEqual(name, 'TestProduct');

    // Clean up
    await query(db, 'DELETE FROM PRODUCTS WHERE ID = 999');
    const after = await query(db, 'SELECT COUNT(*) AS CNT FROM PRODUCTS WHERE ID = 999');
    assert.strictEqual(Number(after[0].CNT ?? after[0].cnt), 0);
  });

  test('UPDATE modifies a row correctly', async function () {
    // Use a dedicated update-test row
    await query(db, "INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (998, 'Before', 1.00)");
    await query(db, "UPDATE PRODUCTS SET NAME = 'After' WHERE ID = 998");

    const rows = await query(db, 'SELECT NAME FROM PRODUCTS WHERE ID = 998');
    const name: string = (rows[0].NAME ?? rows[0].name ?? '').trim();
    assert.strictEqual(name, 'After');

    // Clean up
    await query(db, 'DELETE FROM PRODUCTS WHERE ID = 998');
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

suite('E2E – Query error handling', function () {
  this.timeout(15000);

  let db: Firebird.Database;

  setup(async function () {
    db = await attach();
  });

  teardown(async function () {
    if (db) { await detach(db); }
  });

  test('rejects on invalid SQL', async function () {
    await assert.rejects(
      () => query(db, 'THIS IS NOT VALID SQL'),
      'Expected rejection for invalid SQL',
    );
  });

  test('rejects when querying a non-existent table', async function () {
    await assert.rejects(
      () => query(db, 'SELECT * FROM NON_EXISTENT_TABLE_XYZ'),
      'Expected rejection for non-existent table',
    );
  });
});

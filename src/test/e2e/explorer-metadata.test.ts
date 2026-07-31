/**
 * End-to-end coverage for the DB Explorer's Roles/Exceptions/System Tables
 * additions: creates a real role and exception on the test server, then
 * confirms the exact query builders from shared/queries.ts (the same ones
 * NodeDatabase uses to populate the tree) find them — not a re-implementation
 * of the SQL, the actual functions the extension runs.
 *
 * Same connection env vars as firebird-connection.test.ts:
 *   FIREBIRD_HOST / FIREBIRD_PORT / FIREBIRD_DATABASE / FIREBIRD_USER / FIREBIRD_PASSWORD
 */

import * as assert from 'assert';
import * as Firebird from 'node-firebird';
import { getE2EOptions } from './e2e-connection';
import { getRolesQuery, getExceptionsQuery, getSystemTablesQuery, dropRoleQuery, dropExceptionQuery } from '../../shared/queries';

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

suite('E2E – Roles in the DB Explorer', function () {
  this.timeout(15000);

  let db: Firebird.Database;
  const roleName = 'FS_TEST_ROLE';

  suiteSetup(async function () {
    db = await attach();
    await query(db, `CREATE ROLE ${roleName}`);
  });

  suiteTeardown(async function () {
    if (db) {
      try { await query(db, dropRoleQuery(roleName)); } catch { /* already gone */ }
      await detach(db);
    }
  });

  test('getRolesQuery() finds the newly created role', async function () {
    const rows = await query<{ ROLE_NAME: string }>(db, getRolesQuery());
    const names = rows.map(r => r.ROLE_NAME.trim());
    assert.ok(names.includes(roleName), `expected ${roleName} among: ${names.join(', ')}`);
  });

  test('dropRoleQuery() actually drops the role', async function () {
    await query(db, dropRoleQuery(roleName));
    const rows = await query<{ ROLE_NAME: string }>(db, getRolesQuery());
    const names = rows.map(r => r.ROLE_NAME.trim());
    assert.ok(!names.includes(roleName), `expected ${roleName} to be gone, still present in: ${names.join(', ')}`);

    // Recreate for suiteTeardown's drop-if-exists cleanup to remain a no-op either way.
    await query(db, `CREATE ROLE ${roleName}`);
  });
});

suite('E2E – Exceptions in the DB Explorer', function () {
  this.timeout(15000);

  let db: Firebird.Database;
  const exceptionName = 'FS_TEST_EXCEPTION';
  const message = 'Test exception message';

  suiteSetup(async function () {
    db = await attach();
    await query(db, `CREATE EXCEPTION ${exceptionName} '${message}'`);
  });

  suiteTeardown(async function () {
    if (db) {
      try { await query(db, dropExceptionQuery(exceptionName)); } catch { /* already gone */ }
      await detach(db);
    }
  });

  test('getExceptionsQuery() finds the newly created exception with its message', async function () {
    const rows = await query<{ EXCEPTION_NAME: string; MESSAGE: string }>(db, getExceptionsQuery());
    const match = rows.find(r => r.EXCEPTION_NAME.trim() === exceptionName);
    assert.ok(match, `expected ${exceptionName} among: ${rows.map(r => r.EXCEPTION_NAME.trim()).join(', ')}`);
    assert.strictEqual(String(match!.MESSAGE).trim(), message);
  });

  test('dropExceptionQuery() actually drops the exception', async function () {
    await query(db, dropExceptionQuery(exceptionName));
    const rows = await query<{ EXCEPTION_NAME: string }>(db, getExceptionsQuery());
    const names = rows.map(r => r.EXCEPTION_NAME.trim());
    assert.ok(!names.includes(exceptionName), `expected ${exceptionName} to be gone, still present in: ${names.join(', ')}`);

    // Recreate for suiteTeardown's drop-if-exists cleanup to remain a no-op either way.
    await query(db, `CREATE EXCEPTION ${exceptionName} '${message}'`);
  });
});

suite('E2E – System Tables query (opt-in RDB$ metadata browsing)', function () {
  this.timeout(15000);

  let db: Firebird.Database;

  suiteSetup(async function () {
    db = await attach();
  });

  suiteTeardown(async function () {
    if (db) { await detach(db); }
  });

  test('getSystemTablesQuery() returns well-known Firebird system relations', async function () {
    const rows = await query<{ TABLE_NAME: string }>(db, getSystemTablesQuery());
    const names = rows.map(r => r.TABLE_NAME.trim());
    assert.ok(names.includes('RDB$RELATIONS'), `expected RDB$RELATIONS among system tables, got ${names.length} rows`);
    assert.ok(names.includes('RDB$FIELDS'), `expected RDB$FIELDS among system tables, got ${names.length} rows`);
  });

  test('getSystemTablesQuery() never returns a user table', async function () {
    const rows = await query<{ TABLE_NAME: string }>(db, getSystemTablesQuery());
    const names = rows.map(r => r.TABLE_NAME.trim());
    // PRODUCTS is seeded by scripts/seed-test-db.js as an ordinary user table.
    assert.ok(!names.includes('PRODUCTS'), 'expected the user-created PRODUCTS table to be excluded from system tables');
  });
});

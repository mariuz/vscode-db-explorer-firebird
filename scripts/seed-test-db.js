/**
 * seed-test-db.js
 *
 * Creates the test schema and seeds sample data in the Firebird test database
 * used by the E2E test suite.
 *
 * Run with: node scripts/seed-test-db.js
 *
 * Environment variables (all optional, match the E2E workflow defaults):
 *   FIREBIRD_HOST, FIREBIRD_PORT, FIREBIRD_DATABASE,
 *   FIREBIRD_USER, FIREBIRD_PASSWORD
 */

'use strict';

const Firebird = require('node-firebird');

const options = {
  host:      process.env.FIREBIRD_HOST     || 'localhost',
  port:      Number(process.env.FIREBIRD_PORT || '3050'),
  database:  process.env.FIREBIRD_DATABASE || '/var/lib/firebird/data/test.fdb',
  user:      process.env.FIREBIRD_USER     || 'sysdba',
  password:  process.env.FIREBIRD_PASSWORD || 'masterkey',
  // Firebird 5 defaults to WireCrypt=Enabled; disable for CI test connections
  wireCrypt: Firebird.WIRE_CRYPT_DISABLE,
};

function attach(opts) {
  return new Promise((resolve, reject) => {
    Firebird.attach(opts, (err, db) => {
      if (err) reject(err); else resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function detach(db) {
  return new Promise((resolve, reject) => {
    db.detach(err => {
      if (err) reject(err); else resolve();
    });
  });
}

async function seed() {
  console.log('Connecting to Firebird at', options.host + ':' + options.port, options.database);
  const db = await attach(options);
  console.log('Connected.');

  // ── Create PRODUCTS table ─────────────────────────────────────────────────
  // Drop first if it already exists (idempotent re-runs)
  try {
    await run(db, 'DROP TABLE PRODUCTS');
    console.log('Dropped existing PRODUCTS table.');
  } catch (_) {
    // Table did not exist – that is fine
  }

  await run(db, `
    CREATE TABLE PRODUCTS (
      ID    INTEGER      NOT NULL,
      NAME  VARCHAR(100) NOT NULL,
      PRICE NUMERIC(10,2) NOT NULL,
      CONSTRAINT PK_PRODUCTS PRIMARY KEY (ID)
    )
  `);
  console.log('Created PRODUCTS table.');

  // ── Seed rows ─────────────────────────────────────────────────────────────
  const rows = [
    [1, 'Widget A',  9.99],
    [2, 'Widget B', 19.99],
    [3, 'Gadget X', 49.99],
    [4, 'Gadget Y', 99.99],
    [5, 'Doohickey', 4.99],
  ];

  for (const [id, name, price] of rows) {
    await run(db, 'INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES (?, ?, ?)', [id, name, price]);
  }
  console.log(`Inserted ${rows.length} rows into PRODUCTS.`);

  await detach(db);
  console.log('Seed complete.');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});

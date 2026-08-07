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
 *   FIREBIRD_USER, FIREBIRD_PASSWORD, FIREBIRD_WIRE_CRYPT
 */

'use strict';

const Firebird = require('node-firebird');

// Firebird 5 defaults to WireCrypt=Enabled; CI's container is explicitly
// configured with WireCrypt=Disabled (see .github/workflows/vscode-host.yml
// and e2e.yml), so that's kept as the default here too. Overridable via
// FIREBIRD_WIRE_CRYPT=Enabled for a server that enforces encryption, where
// 'Disabled' fails wire-protocol negotiation outright — node-firebird only
// exposes an ENABLE/DISABLE client toggle (mirrors src/shared/driver.ts's own
// 'Disabled' -> WIRE_CRYPT_DISABLE, anything else -> WIRE_CRYPT_ENABLE mapping).
const options = {
  host:      process.env.FIREBIRD_HOST     || 'localhost',
  port:      Number(process.env.FIREBIRD_PORT || '3050'),
  database:  process.env.FIREBIRD_DATABASE || '/var/lib/firebird/data/test.fdb',
  user:      process.env.FIREBIRD_USER     || 'sysdba',
  password:  process.env.FIREBIRD_PASSWORD || 'masterkey',
  wireCrypt: process.env.FIREBIRD_WIRE_CRYPT === 'Enabled' ? Firebird.WIRE_CRYPT_ENABLE : Firebird.WIRE_CRYPT_DISABLE,
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

  // ── Detect Firebird major version ─────────────────────────────────────────
  let majorVersion = 0;
  try {
    const versionRow = await run(db, "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE");
    if (versionRow && versionRow[0] && versionRow[0].V) {
      const parts = versionRow[0].V.split('.');
      majorVersion = parseInt(parts[0], 10);
    }
  } catch (_) {
    // If it fails, assume pre-6
  }
  console.log('Detected Firebird major version:', majorVersion);

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

  // ── Create CAP_DEMO table ─────────────────────────────────────────────────
  try {
    await run(db, 'DROP TABLE CAP_DEMO');
    console.log('Dropped existing CAP_DEMO table.');
  } catch (_) {}

  await run(db, `
    CREATE TABLE CAP_DEMO (
      ID    INTEGER      NOT NULL,
      NOTE  VARCHAR(100) NOT NULL,
      CONSTRAINT PK_CAP_DEMO PRIMARY KEY (ID)
    )
  `);
  console.log('Created CAP_DEMO table.');
  await run(db, "INSERT INTO CAP_DEMO (ID, NOTE) VALUES (1, 'demo row')");

  // ── Create BIGT table ─────────────────────────────────────────────────────
  try {
    await run(db, 'DROP TABLE BIGT');
    console.log('Dropped existing BIGT table.');
  } catch (_) {}

  await run(db, `
    CREATE TABLE BIGT (
      ID    INTEGER      NOT NULL,
      NOTE  VARCHAR(100) NOT NULL,
      CONSTRAINT PK_BIGT PRIMARY KEY (ID)
    )
  `);
  console.log('Created BIGT table.');

  // Seed 25000 rows into BIGT using an EXECUTE BLOCK for maximum speed
  await run(db, `
    EXECUTE BLOCK AS
    DECLARE I INTEGER = 1;
    BEGIN
      WHILE (I <= 25000) DO
      BEGIN
        INSERT INTO BIGT (ID, NOTE) VALUES (:I, 'row ' || :I);
        I = I + 1;
      END
    END
  `);
  console.log('Seeded 25000 rows into BIGT table.');

  // ── Schema-specific seeding (Firebird 6+) ─────────────────────────────────
  if (majorVersion >= 6) {
    try {
      await run(db, 'DROP TABLE SALES.ORDERS');
      console.log('Dropped existing SALES.ORDERS table.');
    } catch (_) {}

    try {
      await run(db, 'DROP TABLE PUBLIC.ORDERS');
      console.log('Dropped existing PUBLIC.ORDERS table.');
    } catch (_) {}

    try {
      await run(db, 'DROP SCHEMA SALES');
      console.log('Dropped existing SALES schema.');
    } catch (_) {}

    await run(db, 'CREATE SCHEMA SALES');
    console.log('Created SALES schema.');

    await run(db, `
      CREATE TABLE SALES.ORDERS (
        ID    INTEGER NOT NULL PRIMARY KEY,
        TOTAL NUMERIC(10,2)
      )
    `);
    console.log('Created SALES.ORDERS table.');
    await run(db, 'INSERT INTO SALES.ORDERS (ID, TOTAL) VALUES (1, 999.00)');

    await run(db, `
      CREATE TABLE PUBLIC.ORDERS (
        ID    INTEGER NOT NULL PRIMARY KEY,
        NOTE  VARCHAR(100)
      )
    `);
    console.log('Created PUBLIC.ORDERS table.');
    await run(db, "INSERT INTO PUBLIC.ORDERS (ID, NOTE) VALUES (1, 'public-row')");
  }

  await detach(db);
  console.log('Seed complete.');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});

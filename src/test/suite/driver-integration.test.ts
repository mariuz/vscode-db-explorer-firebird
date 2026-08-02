/**
 * Extension Development Host integration tests for the Driver/ClientI
 * abstraction against a real Firebird server.
 *
 * These run inside the real VS Code Extension Development Host (real
 * `vscode` API, real Node.js `node-firebird` client) and exercise the actual
 * production code in src/shared/driver.ts — filling the gap between:
 *   - src/test/*.test.ts   – unit tests with a mocked `vscode` module, no DB.
 *   - src/test/e2e/*.ts    – real Firebird, but calls `node-firebird`
 *                             directly and never touches extension code.
 *
 * Requires the same Firebird service/schema as src/test/e2e (see
 * scripts/seed-test-db.js), configured via the FIREBIRD_* env vars in
 * firebird-test-env.ts.
 */

import * as assert from 'assert';
import { Driver, NodeClient } from '../../shared/driver';
import { getProcedureBodyQuery, getTriggerBodyQuery, getViewDefinitionQuery } from '../../shared/queries';
import { getTestConnectionOptions } from './firebird-test-env';
import { getEngineMajorVersion } from '../../shared/engine-version';
import { supportsSchemas } from '../../shared/schema-support';
import { extractNamedParameters, rewriteNamedParametersToPositional, coerceParamValue } from '../../shared/parameterized-query';

suite('Driver – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    // Bypass Driver.setClient()/CredentialStore (which need a full
    // ExtensionContext) since every call below passes connectionOptions
    // (with password) explicitly.
    Driver.client = new NodeClient();
  });

  test('runQuery executes a simple SELECT', async function () {
    const rows = await Driver.runQuery('SELECT 1 AS ONE FROM RDB$DATABASE', getTestConnectionOptions());
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].ONE), 1);
  });

  test('runQuery returns the seeded PRODUCTS rows', async function () {
    const rows = await Driver.runQuery('SELECT ID, NAME, PRICE FROM PRODUCTS ORDER BY ID', getTestConnectionOptions());
    assert.strictEqual(rows.length, 5);
    assert.strictEqual(rows[0].NAME.trim(), 'Widget A');
    assert.strictEqual(Number(rows[0].PRICE), 9.99);
  });

  test('runQuery rejects on invalid SQL instead of hanging', async function () {
    await assert.rejects(
      Driver.runQuery('SELECT * FROM TABLE_THAT_DOES_NOT_EXIST', getTestConnectionOptions())
    );
  });

  test('runBatch executes multiple statements and returns one BatchResult each', async function () {
    const sql = 'SELECT COUNT(*) AS CNT FROM PRODUCTS; SELECT NAME FROM PRODUCTS WHERE ID = 1;';
    const results = await Driver.runBatch(sql, getTestConnectionOptions());
    assert.strictEqual(results.length, 2);
    assert.strictEqual(Number(results[0].rows![0].CNT), 5);
    assert.strictEqual(results[1].rows![0].NAME.trim(), 'Widget A');
    assert.ok(results[0].durationMs >= 0);
  });

  test('runBatch captures a per-statement error without aborting the batch', async function () {
    const sql = 'SELECT 1 AS OK FROM RDB$DATABASE; SELECT * FROM NOPE_TABLE;';
    const results = await Driver.runBatch(sql, getTestConnectionOptions());
    assert.strictEqual(results.length, 2);
    assert.strictEqual(Number(results[0].rows![0].OK), 1);
    assert.ok(!results[0].error);
    assert.ok(results[1].error, 'second statement should report an error');
  });

  test('runBatch reports a DDL statement as a message result', async function () {
    const sql = 'CREATE TABLE DRIVER_IT_TMP (ID INTEGER NOT NULL);';
    try {
      const results = await Driver.runBatch(sql, getTestConnectionOptions());
      assert.strictEqual(results.length, 1);
      assert.ok(results[0].message);
      assert.ok(!results[0].rows);
    } finally {
      await Driver.runQuery('DROP TABLE DRIVER_IT_TMP', getTestConnectionOptions()).catch(() => { /* best-effort cleanup */ });
    }
  });

  test('getQueryPlan (NodeClient fallback) returns index metadata for PRODUCTS', async function () {
    const plan = await Driver.getQueryPlan('SELECT * FROM PRODUCTS WHERE ID = 1', getTestConnectionOptions());
    assert.ok(plan.includes('PRODUCTS'));
  });

  test('runQuery binds a positional ? parameter against the live seeded PRODUCTS table', async function () {
    const rows = await Driver.runQuery('SELECT NAME FROM PRODUCTS WHERE ID = ?', getTestConnectionOptions(), [1]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].NAME.trim(), 'Widget A');
  });

  test('a full :namedParam query (Object Explorer Filters-style) round-trips end-to-end', async function () {
    // Mirrors exactly what firebird.runParameterizedQuery does: extract names, prompt (simulated
    // here by coerceParamValue directly), rewrite to positional ?, then run through Driver.runQuery.
    const sql = 'SELECT NAME, PRICE FROM PRODUCTS WHERE ID = :productId';
    const names = extractNamedParameters(sql);
    assert.deepStrictEqual(names, ['productId']);

    const { sql: positionalSql, paramNames } = rewriteNamedParametersToPositional(sql);
    assert.strictEqual(positionalSql, 'SELECT NAME, PRICE FROM PRODUCTS WHERE ID = ?');

    const params = paramNames.map(() => coerceParamValue('integer', '1'));
    const rows = await Driver.runQuery(positionalSql, getTestConnectionOptions(), params);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].NAME.trim(), 'Widget A');
    assert.strictEqual(Number(rows[0].PRICE), 9.99);
  });

  // ── Batch execution of PSQL blocks (SET TERM) ──────────────────────────────
  //
  // The extension's own CREATE PROCEDURE/TRIGGER snippets wrap the body in
  // `SET TERM ^ ; ... END^ SET TERM ; ^` so the semicolons inside the
  // procedure body aren't mistaken for statement boundaries. These tests run
  // that exact convention through Driver.runBatch() against a live server —
  // proving a pasted snippet is actually executable end to end, not just
  // that the splitter's output looks right in isolation (see
  // src/test/sql-splitter.test.ts for the splitter's own unit coverage).

  test('runBatch creates and calls a stored procedure defined with SET TERM, matching the CREATE PROCEDURE snippet', async function () {
    const sql = [
      'SET TERM ^ ;',
      'CREATE PROCEDURE DRIVER_IT_ADD_ONE (P1 INTEGER)',
      'RETURNS (OUT1 INTEGER)',
      'AS',
      'BEGIN',
      '  OUT1 = P1 + 1;',
      '  SUSPEND;',
      'END^',
      'SET TERM ; ^',
      '',
      'SELECT * FROM DRIVER_IT_ADD_ONE(41);',
    ].join('\n');

    try {
      const results = await Driver.runBatch(sql, getTestConnectionOptions());
      assert.strictEqual(results.length, 2, 'SET TERM lines must be consumed, not executed as statements');
      assert.ok(!results[0].error, `CREATE PROCEDURE failed: ${results[0].error}`);
      assert.ok(results[0].message?.includes('Create'));
      assert.ok(!results[1].error, `SELECT FROM procedure failed: ${results[1].error}`);
      assert.strictEqual(Number(results[1].rows![0].OUT1), 42);
    } finally {
      await Driver.runQuery('DROP PROCEDURE DRIVER_IT_ADD_ONE', getTestConnectionOptions()).catch(() => { /* best-effort cleanup */ });
    }
  });

  test('runBatch creates and calls a bare stored procedure with a DECLARE VARIABLE section (no SET TERM)', async function () {
    const sql = [
      'CREATE PROCEDURE DRIVER_IT_DOUBLE (P1 INTEGER)',
      'RETURNS (OUT1 INTEGER)',
      'AS',
      '  DECLARE VARIABLE v_temp INTEGER;',
      'BEGIN',
      '  v_temp = P1 * 2;',
      '  OUT1 = v_temp;',
      '  SUSPEND;',
      'END;',
      '',
      'SELECT * FROM DRIVER_IT_DOUBLE(21);',
    ].join('\n');

    try {
      const results = await Driver.runBatch(sql, getTestConnectionOptions());
      assert.strictEqual(results.length, 2, 'the DECLARE VARIABLE section must not split the CREATE PROCEDURE statement');
      assert.ok(!results[0].error, `CREATE PROCEDURE failed: ${results[0].error}`);
      assert.ok(!results[1].error, `SELECT FROM procedure failed: ${results[1].error}`);
      assert.strictEqual(Number(results[1].rows![0].OUT1), 42);
    } finally {
      await Driver.runQuery('DROP PROCEDURE DRIVER_IT_DOUBLE', getTestConnectionOptions()).catch(() => { /* best-effort cleanup */ });
    }
  });

  // ── Fetching DDL source for editing (procedure/trigger/view) ───────────────
  //
  // Regression coverage for "SQL error code = -204, Data type unknown,
  // Implementation limit exceeded, COLUMN": NodeProcedure/NodeTrigger/NodeView's
  // "edit source" actions fetch RDB$*_SOURCE via CAST(... AS VARCHAR(n)) —
  // these tests run those exact queries against a real Firebird server, whose
  // default connection charset (UTF8) is what caused the CAST to overflow
  // Firebird's 32767-byte column limit before the fix pinned CHARACTER SET
  // UTF8 explicitly with a charset-safe length.

  test('fetches a stored procedure\'s source without a -204 "Implementation limit exceeded" error', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runQuery(
      // EXIT (not SUSPEND) since this procedure has no RETURNS clause.
      'CREATE PROCEDURE DRIVER_IT_SRC_PROC AS BEGIN\n  EXIT;\nEND',
      conn
    );
    try {
      const connection = await Driver.client.createConnection(conn);
      const rows = await Driver.client.queryPromise<any>(connection, getProcedureBodyQuery('DRIVER_IT_SRC_PROC'));
      await Driver.client.detach(connection);
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0].PROCEDURE_SOURCE.includes('EXIT'), rows[0].PROCEDURE_SOURCE);
    } finally {
      await Driver.runQuery('DROP PROCEDURE DRIVER_IT_SRC_PROC', conn).catch(() => { /* best-effort cleanup */ });
    }
  });

  test('fetches a trigger\'s source without a -204 error', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runQuery(
      'CREATE TRIGGER DRIVER_IT_SRC_TRIG FOR PRODUCTS ACTIVE BEFORE INSERT POSITION 0 AS BEGIN\n  IF (NEW.ID IS NULL) THEN NEW.ID = 0;\nEND',
      conn
    );
    try {
      const connection = await Driver.client.createConnection(conn);
      const rows = await Driver.client.queryPromise<any>(connection, getTriggerBodyQuery('DRIVER_IT_SRC_TRIG'));
      await Driver.client.detach(connection);
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0].TRIGGER_SOURCE.includes('NEW.ID'), rows[0].TRIGGER_SOURCE);
    } finally {
      await Driver.runQuery('DROP TRIGGER DRIVER_IT_SRC_TRIG', conn).catch(() => { /* best-effort cleanup */ });
    }
  });

  test('fetches a view\'s source without a -204 error', async function () {
    const conn = getTestConnectionOptions();
    await Driver.runQuery('CREATE VIEW DRIVER_IT_SRC_VIEW AS SELECT ID, NAME FROM PRODUCTS', conn);
    try {
      const connection = await Driver.client.createConnection(conn);
      const rows = await Driver.client.queryPromise<any>(connection, getViewDefinitionQuery('DRIVER_IT_SRC_VIEW'));
      await Driver.client.detach(connection);
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0].VIEW_SOURCE.includes('PRODUCTS'), rows[0].VIEW_SOURCE);
    } finally {
      await Driver.runQuery('DROP VIEW DRIVER_IT_SRC_VIEW', conn).catch(() => { /* best-effort cleanup */ });
    }
  });
});

/**
 * Per-connection default schema (docs/roadmap/firebird6-schemas.md, phase 3).
 *
 * The point of this tier for this feature: everything else about it is plumbing that unit tests can
 * check, but whether `ConnectionOptions.defaultSchema` actually changes how the *server* resolves an
 * unqualified name can only be established by asking a real Firebird 6. The probe table exists in
 * one schema only, so resolving it is proof the search path arrived — a table present in both
 * schemas would resolve either way and prove nothing.
 */
suite('Driver – per-connection default schema (extension host)', function () {
  this.timeout(30000);

  const SCHEMA = 'DRIVER_SP_TEST';
  const TABLE = 'SP_PROBE';
  let major = 0;

  suiteSetup(async function () {
    Driver.client = new NodeClient();
    major = await getEngineMajorVersion('suite-default-schema', sql => Driver.runQuery(sql, getTestConnectionOptions()));
    if (!supportsSchemas(major)) {
      return;
    }
    await Driver.runQuery(`CREATE SCHEMA ${SCHEMA}`, getTestConnectionOptions()).catch(() => undefined);
    await Driver.runQuery(`CREATE TABLE ${SCHEMA}.${TABLE} (ID INTEGER)`, getTestConnectionOptions()).catch(() => undefined);
    await Driver.runQuery(`INSERT INTO ${SCHEMA}.${TABLE} VALUES (7)`, getTestConnectionOptions()).catch(() => undefined);
  });

  suiteTeardown(async function () {
    if (!supportsSchemas(major)) {
      return;
    }
    await Driver.runQuery(`DROP TABLE ${SCHEMA}.${TABLE}`, getTestConnectionOptions()).catch(() => undefined);
    await Driver.runQuery(`DROP SCHEMA ${SCHEMA}`, getTestConnectionOptions()).catch(() => undefined);
  });

  test('an unqualified name resolves through the connection\'s default schema', async function () {
    if (!supportsSchemas(major)) {
      this.skip();
    }
    const rows = await Driver.runQuery(
      `SELECT ID FROM ${TABLE}`,
      { ...getTestConnectionOptions(), defaultSchema: SCHEMA }
    );
    assert.strictEqual(Number(rows[0].ID), 7);
  });

  test('without it, the same statement fails — which is what makes the test above mean something', async function () {
    if (!supportsSchemas(major)) {
      this.skip();
    }
    await assert.rejects(
      Driver.runQuery(`SELECT ID FROM ${TABLE}`, getTestConnectionOptions()),
      /Table unknown|SP_PROBE/i
    );
  });

  test('the search path reported by the server names the schema first', async function () {
    if (!supportsSchemas(major)) {
      this.skip();
    }
    // PUBLIC stays behind it as a fallback and the server appends SYSTEM itself, so this asserts
    // position rather than the whole string.
    const rows = await Driver.runQuery(
      "SELECT RDB$GET_CONTEXT('SYSTEM','SEARCH_PATH') AS SP FROM RDB$DATABASE",
      { ...getTestConnectionOptions(), defaultSchema: SCHEMA }
    );
    const path = String(rows[0].SP);
    assert.ok(path.startsWith(`"${SCHEMA}"`), `expected ${SCHEMA} first, got ${path}`);
    assert.ok(path.includes('PUBLIC'), `expected PUBLIC kept as a fallback, got ${path}`);
  });
});

/**
 * Extension Development Host integration tests for the DB Explorer tree
 * nodes (src/nodes/*) against a real Firebird server.
 *
 * Complements driver-integration.test.ts by exercising the node hierarchy
 * (NodeDatabase -> category folders -> NodeTable -> NodeField) and the
 * table-level actions (selectAllRecords) that the tree view drives, using
 * the same seeded PRODUCTS table as src/test/e2e (see scripts/seed-test-db.js).
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { Driver, NodeClient } from '../../shared/driver';
import { NodeDatabase, NodeHost, NodeTable } from '../../nodes';
import { FirebirdTree } from '../../interfaces';
import { getTestConnectionOptions } from './firebird-test-env';
import { setObjectFilter, clearObjectFilter } from '../../shared/object-explorer-filter';
import { getObjectPrivilegesQuery, SCHEMA_OBJECT_TYPE } from '../../shared/queries';
import { getEngineMajorVersion } from '../../shared/engine-version';
import { supportsSchemas } from '../../shared/schema-support';

const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';

suite('Tree nodes – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  let fakeContext: vscode.ExtensionContext;
  let major = 0;
  let originalMaxTables: any;

  suiteSetup(async function () {
    const config = vscode.workspace.getConfiguration('firebird');
    originalMaxTables = config.inspect('maxTablesCount')?.globalValue;
    await config.update('maxTablesCount', 0, true);

    Driver.client = new NodeClient();
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension "${EXTENSION_ID}" should be installed in the test host`);
    // getTreeItem() on these node classes only reads context.extensionPath
    // (to build icon paths), so a minimal stand-in is enough here — we don't
    // need a full ExtensionContext (globalState/secrets) for these tests.
    fakeContext = { extensionPath: extension!.extensionPath } as unknown as vscode.ExtensionContext;

    // Drop the SALES schema so the database has exactly one user schema (PUBLIC).
    // This forces the explorer tree to render the flat category folders layout for testing.
    major = await getEngineMajorVersion('suite-tree-setup', sql => Driver.runQuery(sql, getTestConnectionOptions()));
    if (supportsSchemas(major)) {
      await Driver.runQuery('DROP TABLE SALES.ORDERS', getTestConnectionOptions()).catch(() => undefined);
      await Driver.runQuery('DROP SCHEMA SALES', getTestConnectionOptions()).catch(() => undefined);
    }
  });

  suiteTeardown(async function () {
    const config = vscode.workspace.getConfiguration('firebird');
    await config.update('maxTablesCount', originalMaxTables, true);

    if (supportsSchemas(major)) {
      // Recreate SALES schema/tables for downstream Playwright tests
      await Driver.runQuery('CREATE SCHEMA SALES', getTestConnectionOptions()).catch(() => undefined);
      await Driver.runQuery('CREATE TABLE SALES.ORDERS (ID INTEGER NOT NULL PRIMARY KEY, TOTAL NUMERIC(10,2))', getTestConnectionOptions()).catch(() => undefined);
      await Driver.runQuery('INSERT INTO SALES.ORDERS (ID, TOTAL) VALUES (1, 999.00)', getTestConnectionOptions()).catch(() => undefined);
    }
  });

  test('NodeHost.getChildren wraps each saved connection in a NodeDatabase', async function () {
    const host = new NodeHost('localhost', [getTestConnectionOptions()]);
    const children = await host.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof NodeDatabase);
  });

  test('NodeDatabase.getChildren returns the nine object-category folders (System Tables hidden by default)', async function () {
    const db = new NodeDatabase(getTestConnectionOptions());
    const children = await db.getChildren();
    const labels = await Promise.all(children.map(async c => (await c.getTreeItem(fakeContext)).label));
    assert.deepStrictEqual(labels, ['Tables', 'Views', 'Stored Procedures', 'Triggers', 'Generators', 'Domains', 'Roles', 'Exceptions', 'Users']);
  });

  test('Tables folder lists the seeded PRODUCTS table', async function () {
    const db = new NodeDatabase(getTestConnectionOptions());
    const [tablesFolder] = await db.getChildren();
    const tables = await tablesFolder.getChildren();
    const labels = await Promise.all(tables.map(async t => (await t.getTreeItem(fakeContext)).label));
    assert.ok(labels.includes('PRODUCTS'), `expected PRODUCTS in ${JSON.stringify(labels)}`);
  });

  test('NodeTable.getChildren lists PRODUCTS columns as NodeField', async function () {
    const productsTable = new NodeTable(getTestConnectionOptions(), 'PRODUCTS');
    const fields: FirebirdTree[] = await productsTable.getChildren();
    const labels = await Promise.all(fields.map(async f => (await f.getTreeItem(fakeContext)).label as string));
    assert.ok(labels.some(l => l.startsWith('ID :')), `expected an ID column in ${JSON.stringify(labels)}`);
    assert.ok(labels.some(l => l.startsWith('NAME :')));
    assert.ok(labels.some(l => l.startsWith('PRICE :')));
  });

  test('NodeTable.selectAllRecords returns the seeded rows end-to-end', async function () {
    const productsTable = new NodeTable(getTestConnectionOptions(), 'PRODUCTS');
    const rows = await productsTable.selectAllRecords();
    assert.strictEqual(rows.length, 5);
  });

  suite('Object Explorer Filters', function () {
    const connectionId = getTestConnectionOptions().id;

    teardown(function () {
      clearObjectFilter(connectionId, 'tables');
    });

    test('a matching filter narrows the Tables folder to only PRODUCTS', async function () {
      setObjectFilter(connectionId, 'tables', 'PROD');
      const db = new NodeDatabase(getTestConnectionOptions());
      const [tablesFolder] = await db.getChildren();
      const tables = await tablesFolder.getChildren();
      const labels = await Promise.all(tables.map(async t => (await t.getTreeItem(fakeContext)).label));
      assert.deepStrictEqual(labels, ['PRODUCTS']);
    });

    test('a non-matching filter empties the Tables folder', async function () {
      setObjectFilter(connectionId, 'tables', 'NO_SUCH_TABLE_XYZ');
      const db = new NodeDatabase(getTestConnectionOptions());
      const [tablesFolder] = await db.getChildren();
      const tables = await tablesFolder.getChildren();
      assert.strictEqual(tables.length, 0);
    });

    test('the folder label reflects the active filter', async function () {
      setObjectFilter(connectionId, 'tables', 'PROD');
      const db = new NodeDatabase(getTestConnectionOptions());
      const [tablesFolder] = await db.getChildren();
      const item = await tablesFolder.getTreeItem(fakeContext);
      assert.ok(String(item.label).includes('filtered: "PROD"'), String(item.label));
    });

    test('clearing the filter restores the unfiltered Tables folder', async function () {
      setObjectFilter(connectionId, 'tables', 'PROD');
      clearObjectFilter(connectionId, 'tables');
      const db = new NodeDatabase(getTestConnectionOptions());
      const [tablesFolder] = await db.getChildren();
      const tables = await tablesFolder.getChildren();
      const labels = await Promise.all(tables.map(async t => (await t.getTreeItem(fakeContext)).label));
      assert.ok(labels.includes('PRODUCTS'), `expected PRODUCTS in ${JSON.stringify(labels)}`);
      const item = await tablesFolder.getTreeItem(fakeContext);
      assert.strictEqual(item.label, 'Tables');
    });
  });
});

/**
 * Schema-level grants (docs/roadmap/firebird6-schemas.md, phase 6).
 *
 * These pin two catalogue facts that no amount of reading the code can establish, and that the
 * documentation does not state: that a `GRANT USAGE ON SCHEMA` is recorded in RDB$USER_PRIVILEGES
 * under `RDB$OBJECT_TYPE = 38` with privilege code `G`, and that such a row leaves
 * RDB$RELATION_SCHEMA_NAME null. `RDB$TYPES` names object types 0–19 and 37 on Firebird 6.0.0 and
 * stops there, so 38 cannot be looked up — if a later Firebird renumbers it, this test is what says
 * so, rather than the schema privileges silently coming back empty.
 */
suite('Schema privileges – real Firebird 6 integration (extension host)', function () {
  this.timeout(20000);

  let major = 0;

  suiteSetup(async function () {
    Driver.client = new NodeClient();
    major = await getEngineMajorVersion(
      'suite-schema-privileges',
      sql => Driver.runQuery(sql, getTestConnectionOptions())
    );
  });

  test('the PUBLIC schema has USAGE grants recorded against object type 38', async function () {
    if (!supportsSchemas(major)) {
      this.skip(); // pre-6 server: schemas do not exist, and neither does the grant
    }
    const rows = await Driver.runQuery(
      getObjectPrivilegesQuery('PUBLIC', {objectType: SCHEMA_OBJECT_TYPE}),
      getTestConnectionOptions()
    );
    assert.ok(rows.length > 0, 'expected at least the owner grant on the PUBLIC schema');
    assert.ok(
      rows.every((r: any) => String(r.PRIVILEGE).trim() === 'USAGE'),
      `expected every schema grant to map to USAGE, got ${JSON.stringify(rows.map((r: any) => r.PRIVILEGE))}`
    );
  });

  test('the object-type filter is what separates a schema from a same-named table', async function () {
    if (!supportsSchemas(major)) {
      this.skip();
    }
    // Without the filter the query answers for any securable called PUBLIC; with it, only the
    // schema. Asserting the SQL differs is not enough — this checks the server agrees.
    const unfiltered = await Driver.runQuery(
      getObjectPrivilegesQuery('PUBLIC'),
      getTestConnectionOptions()
    );
    const filtered = await Driver.runQuery(
      getObjectPrivilegesQuery('PUBLIC', {objectType: SCHEMA_OBJECT_TYPE}),
      getTestConnectionOptions()
    );
    assert.ok(filtered.length <= unfiltered.length);
    assert.ok(filtered.length > 0);
  });

  test('a schema-qualified object query prepares on a real Firebird 6 server', async function () {
    if (!supportsSchemas(major)) {
      this.skip();
    }
    // RDB$RELATION_SCHEMA_NAME is the column that does not exist before 6; naming it on a server
    // that lacks it fails at prepare time, so this is the check that the guard is on the right side.
    const rows = await Driver.runQuery(
      getObjectPrivilegesQuery('PRODUCTS', {schema: 'PUBLIC'}),
      getTestConnectionOptions()
    );
    assert.ok(Array.isArray(rows));
  });
});

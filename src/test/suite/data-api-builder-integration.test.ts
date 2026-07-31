/**
 * Extension Development Host integration test for the Data API Builder
 * (docs/roadmap/data-api-builder.md). Had no suite-tier coverage at all before this — only the
 * pure `buildOpenApiSpec()`/`jsonSchemaForColumn()` (fake schema graphs) and
 * `copilotScopingPrompt()`/`parseTableAccessResponse()` (fake model responses) were unit-tested;
 * nothing had ever driven `runDataApiSpecGenerator()` end-to-end against a real connection and a
 * real opened editor.
 *
 * `runDataApiSpecGenerator()` genuinely opens a real VS Code text editor with the generated spec
 * (`vscode.workspace.openTextDocument()` + `showTextDocument()`) — unlike the webview-panel-based
 * features (profiler/query-plan-view), this is directly observable through
 * `vscode.window.activeTextEditor`, so this test reads the real generated document back rather
 * than needing to monkey-patch anything.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { runDataApiSpecGenerator } from '../../data-api-builder';
import { buildOpenApiSpec } from '../../data-api-builder/openapi-spec';
import { buildSchemaGraph, SchemaGraph } from '../../schema-designer/schema-graph';
import { getSchemaColumnsQuery, getForeignKeysQuery } from '../../shared/queries';
import { Driver, NodeClient } from '../../shared/driver';
import { getTestConnectionOptions } from './firebird-test-env';

suite('Data API Builder – real Firebird integration (extension host)', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    if (ext && !ext.isActive) { await ext.activate(); }
    // Bypass Driver.setClient()/CredentialStore, same as driver-integration.test.ts: activate()
    // runs the copy of Driver bundled inside out/extension.js, a separate module instance (own
    // independent static state) from the plain-tsc-compiled out/shared/driver.js this suite-tier
    // test file's own `import { Driver } from '../../shared/driver'` resolves to (and that
    // runDataApiSpecGenerator() itself imports), so real activation never touches the copy this
    // test uses. getTestConnectionOptions() supplies the password explicitly, so no
    // ExtensionContext is needed.
    Driver.client = new NodeClient();
  });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('generates a real OpenAPI 3.0 spec from the live schema and opens it as a JSON document', async function () {
    await runDataApiSpecGenerator(getTestConnectionOptions());

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'expected a new text editor with the generated spec to be open');
    assert.strictEqual(editor!.document.languageId, 'json');

    const spec = JSON.parse(editor!.document.getText());
    assert.strictEqual(spec.openapi, '3.0.3');
    assert.ok(spec.paths['/products'], `expected a /products path from the real PRODUCTS table, got paths: ${Object.keys(spec.paths).join(', ')}`);
  });

  test('the generated spec\'s /products schema reflects the table\'s real columns', async function () {
    await runDataApiSpecGenerator(getTestConnectionOptions());
    const spec = JSON.parse(vscode.window.activeTextEditor!.document.getText());

    const schema = spec.components.schemas.PRODUCTS;
    assert.ok(schema, `expected a PRODUCTS schema, got: ${Object.keys(spec.components?.schemas ?? {}).join(', ')}`);
    assert.ok('ID' in schema.properties, JSON.stringify(schema.properties));
    assert.ok('NAME' in schema.properties, JSON.stringify(schema.properties));
    assert.ok('PRICE' in schema.properties, JSON.stringify(schema.properties));
  });

  test('a full-access table gets all four CRUD operations on its collection path', async function () {
    await runDataApiSpecGenerator(getTestConnectionOptions());
    const spec = JSON.parse(vscode.window.activeTextEditor!.document.getText());

    const collection = spec.paths['/products'];
    assert.ok(collection.get, 'expected GET /products');
    assert.ok(collection.post, 'expected POST /products (full access, not scoped read-only)');
  });
});

suite('Data API Builder – column scoping against a real schema (phase 5)', function () {
  this.timeout(20000);

  suiteSetup(function () {
    Driver.client = new NodeClient();
  });

  /** The same fetch runDataApiSpecGenerator() does, so this filters a genuinely real schema graph. */
  async function realGraph(): Promise<SchemaGraph> {
    const conn = getTestConnectionOptions();
    const [columns, foreignKeys] = await Driver.runBatch(
      `${getSchemaColumnsQuery()};\n${getForeignKeysQuery()};`,
      conn
    );
    return buildSchemaGraph((columns.rows ?? []) as any, (foreignKeys.rows ?? []) as any);
  }

  test('a real column can be excluded from a real table\'s generated schema', async function () {
    const graph = await realGraph();
    const products = graph.tables.find(t => t.name === 'PRODUCTS');
    assert.ok(products, `PRODUCTS not found in the live schema (${graph.tables.map(t => t.name).join(', ')})`);

    const victim = products!.columns.find(c => !c.isPrimaryKey);
    assert.ok(victim, 'PRODUCTS should have at least one non-primary-key column');

    const spec = buildOpenApiSpec(graph, {
      tableAccess: { PRODUCTS: { access: 'read-only', excludeColumns: [victim!.name] } },
    });

    const properties = Object.keys(spec.components.schemas.PRODUCTS.properties);
    assert.ok(!properties.includes(victim!.name), `${victim!.name} should have been excluded, got ${properties}`);
    assert.strictEqual(properties.length, products!.columns.length - 1);
    assert.ok(properties.length > 0, 'the other real columns should still be present');
  });

  test('excluding a real primary-key column drops the by-PK route for that real table', async function () {
    const graph = await realGraph();
    const products = graph.tables.find(t => t.name === 'PRODUCTS');
    const pk = products?.columns.find(c => c.isPrimaryKey);
    if (!pk) { this.skip(); }

    const spec = buildOpenApiSpec(graph, {
      tableAccess: { PRODUCTS: { access: 'read-only', excludeColumns: [pk!.name] } },
    });
    assert.ok('/products' in spec.paths, 'the list route should survive');
    assert.ok(
      !Object.keys(spec.paths).some(p => p.startsWith('/products/')),
      `no by-PK route expected, got ${Object.keys(spec.paths).join(', ')}`
    );
  });
});

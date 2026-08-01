import * as assert from 'assert';
import { buildOpenApiSpec, jsonSchemaForColumn } from '../data-api-builder/openapi-spec';
import { SchemaGraph, SchemaColumn, SchemaTable } from '../schema-designer/schema-graph';

function column(overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name: 'ID', type: 'INTEGER', length: 0, notNull: true, isPrimaryKey: false, ...overrides };
}

function table(name: string, columns: SchemaColumn[]): SchemaTable {
  return { name, columns };
}

suite('openapi-spec – jsonSchemaForColumn()', function () {
  test('maps INTEGER to an integer schema', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'INTEGER' })), { type: 'integer' });
  });

  test('maps INT64 to an integer schema with int64 format', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'INT64' })), { type: 'integer', format: 'int64' });
  });

  test('maps TIMESTAMP to a string schema with date-time format', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'TIMESTAMP' })), { type: 'string', format: 'date-time' });
  });

  test('maps DATE to a string schema with date format', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'DATE' })), { type: 'string', format: 'date' });
  });

  test('maps VARCHAR with a length to a string schema with maxLength', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'VARCHAR', length: 50 })), { type: 'string', maxLength: 50 });
  });

  test('omits maxLength for VARCHAR with no length', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'VARCHAR', length: 0 })), { type: 'string' });
  });

  test('falls back to a bare string schema for an unmapped/UNKNOWN type', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'UNKNOWN' })), { type: 'string' });
  });

  test('adds nullable: true for a nullable column', function () {
    assert.deepStrictEqual(jsonSchemaForColumn(column({ type: 'INTEGER', notNull: false })), { type: 'integer', nullable: true });
  });

  test('omits nullable for a NOT NULL column', function () {
    const schema = jsonSchemaForColumn(column({ type: 'INTEGER', notNull: true }));
    assert.strictEqual('nullable' in schema, false);
  });
});

suite('openapi-spec – buildOpenApiSpec()', function () {
  test('produces a valid OpenAPI 3.0.3 envelope with a title/version', function () {
    const graph: SchemaGraph = { tables: [], relationships: [] };
    const spec = buildOpenApiSpec(graph, { title: 'My API', version: '2.0.0' });
    assert.strictEqual(spec.openapi, '3.0.3');
    assert.deepStrictEqual(spec.info, { title: 'My API', version: '2.0.0' });
  });

  test('defaults title/version when not given', function () {
    const spec = buildOpenApiSpec({ tables: [], relationships: [] });
    assert.strictEqual(spec.info.title, 'Firebird Data API');
    assert.strictEqual(spec.info.version, '1.0.0');
  });

  test('generates a component schema per table with one property per column', function () {
    const graph: SchemaGraph = {
      tables: [table('CUSTOMERS', [
        column({ name: 'ID', type: 'INTEGER', isPrimaryKey: true, notNull: true }),
        column({ name: 'NAME', type: 'VARCHAR', length: 100, notNull: true }),
        column({ name: 'NOTES', type: 'VARCHAR', length: 200, notNull: false }),
      ])],
      relationships: [],
    };
    const spec = buildOpenApiSpec(graph);
    const schema = spec.components.schemas.CUSTOMERS;
    assert.strictEqual(schema.type, 'object');
    assert.deepStrictEqual(Object.keys(schema.properties), ['ID', 'NAME', 'NOTES']);
    assert.deepStrictEqual(schema.required, ['ID', 'NAME']);
    assert.strictEqual(schema.properties.NOTES.nullable, true);
  });

  test('generates list (GET/POST) routes for every table', function () {
    const graph: SchemaGraph = { tables: [table('ORDERS', [column({ name: 'ID', isPrimaryKey: true })])], relationships: [] };
    const spec = buildOpenApiSpec(graph);
    const listPath = spec.paths['/orders'];
    assert.ok(listPath.get, 'expected a GET (list) operation');
    assert.ok(listPath.post, 'expected a POST (create) operation');
    assert.strictEqual(listPath.get.responses['200'].content['application/json'].schema.type, 'array');
  });

  test('generates by-primary-key (GET/PUT/DELETE) routes when the table has a PK', function () {
    const graph: SchemaGraph = { tables: [table('ORDERS', [column({ name: 'ID', isPrimaryKey: true })])], relationships: [] };
    const spec = buildOpenApiSpec(graph);
    const itemPath = spec.paths['/orders/{ID}'];
    assert.ok(itemPath, 'expected an /orders/{ID} path');
    assert.ok(itemPath.get);
    assert.ok(itemPath.put);
    assert.ok(itemPath.delete);
    assert.strictEqual(itemPath.parameters.length, 1);
    assert.strictEqual(itemPath.parameters[0].name, 'ID');
  });

  test('builds a composite-key path segment for a multi-column primary key', function () {
    const graph: SchemaGraph = {
      tables: [table('ORDER_ITEMS', [
        column({ name: 'ORDER_ID', isPrimaryKey: true }),
        column({ name: 'LINE_NO', isPrimaryKey: true }),
      ])],
      relationships: [],
    };
    const spec = buildOpenApiSpec(graph);
    assert.ok(spec.paths['/order_items/{ORDER_ID}/{LINE_NO}']);
  });

  test('omits the by-primary-key path entirely when a table has no primary key', function () {
    const graph: SchemaGraph = { tables: [table('LOG', [column({ name: 'MESSAGE', type: 'VARCHAR', isPrimaryKey: false })])], relationships: [] };
    const spec = buildOpenApiSpec(graph);
    assert.ok(spec.paths['/log'], 'the list path should still exist');
    assert.strictEqual(Object.keys(spec.paths).filter(p => p.startsWith('/log/')).length, 0);
  });

  test('every $ref in paths points at a schema that actually exists in components', function () {
    const graph: SchemaGraph = {
      tables: [
        table('A', [column({ name: 'ID', isPrimaryKey: true })]),
        table('B', [column({ name: 'ID', isPrimaryKey: true })]),
      ],
      relationships: [],
    };
    const spec = buildOpenApiSpec(graph);
    const refs = JSON.stringify(spec.paths).match(/#\/components\/schemas\/\w+/g) ?? [];
    assert.ok(refs.length > 0, 'expected at least one $ref');
    refs.forEach(ref => {
      const name = ref.replace('#/components/schemas/', '');
      assert.ok(spec.components.schemas[name], `schema "${name}" referenced by ${ref} should exist`);
    });
  });
});

// ── tableAccess option (phase 3: Copilot-assisted scoping) ──────────────────

suite('openapi-spec – buildOpenApiSpec() with tableAccess', function () {
  const graph: SchemaGraph = {
    tables: [
      table('CUSTOMERS', [column({ name: 'ID', isPrimaryKey: true })]),
      table('ORDERS', [column({ name: 'ID', isPrimaryKey: true })]),
      table('LOG', [column({ name: 'ID', isPrimaryKey: true })]),
    ],
    relationships: [],
  };

  test('includes every table with full CRUD when tableAccess is not set (unchanged default behavior)', function () {
    const spec = buildOpenApiSpec(graph);
    assert.deepStrictEqual(Object.keys(spec.components.schemas).sort(), ['CUSTOMERS', 'LOG', 'ORDERS']);
  });

  test('includes only the tables named in tableAccess', function () {
    const spec = buildOpenApiSpec(graph, { tableAccess: { CUSTOMERS: 'full' } });
    assert.deepStrictEqual(Object.keys(spec.components.schemas), ['CUSTOMERS']);
    assert.strictEqual(spec.paths['/orders'], undefined);
    assert.strictEqual(spec.paths['/log'], undefined);
  });

  test('a "full" table gets POST on the list path and PUT/DELETE on the item path', function () {
    const spec = buildOpenApiSpec(graph, { tableAccess: { CUSTOMERS: 'full' } });
    assert.ok(spec.paths['/customers'].post, 'expected POST on the list path');
    assert.ok(spec.paths['/customers/{ID}'].put, 'expected PUT on the item path');
    assert.ok(spec.paths['/customers/{ID}'].delete, 'expected DELETE on the item path');
  });

  test('a "read-only" table has no POST/PUT/DELETE, only GET', function () {
    const spec = buildOpenApiSpec(graph, { tableAccess: { CUSTOMERS: 'read-only' } });
    assert.ok(spec.paths['/customers'].get, 'expected GET on the list path');
    assert.strictEqual(spec.paths['/customers'].post, undefined);
    assert.ok(spec.paths['/customers/{ID}'].get, 'expected GET on the item path');
    assert.strictEqual(spec.paths['/customers/{ID}'].put, undefined);
    assert.strictEqual(spec.paths['/customers/{ID}'].delete, undefined);
  });

  test('an empty tableAccess object excludes every table', function () {
    const spec = buildOpenApiSpec(graph, { tableAccess: {} });
    assert.deepStrictEqual(spec.paths, {});
    assert.deepStrictEqual(spec.components.schemas, {});
  });
});

suite('buildOpenApiSpec() — Firebird 6 schema names', function () {
  const table = (name: string, displayName?: string) => ({
    name,
    ...(displayName ? { displayName } : {}),
    columns: [{ name: 'ID', type: 'INTEGER', length: 4, notNull: true, isPrimaryKey: true }],
  });

  test('publishes the display name, so a default-schema table keeps a clean route', function () {
    // The graph's `name` is qualified because it doubles as the table's DDL identity; putting that
    // in a URL would give every path on a single-schema database a redundant `public.` segment.
    const spec: any = buildOpenApiSpec({ tables: [table('PUBLIC.ORDERS', 'ORDERS')], relationships: [] } as any, {});
    assert.ok(spec.paths['/orders'], Object.keys(spec.paths).join(', '));
    assert.ok(spec.components.schemas['ORDERS']);
  });

  test('keeps a qualification that actually disambiguates', function () {
    const spec: any = buildOpenApiSpec({ tables: [table('SALES.ORDERS')], relationships: [] } as any, {});
    assert.ok(spec.paths['/sales.orders'], Object.keys(spec.paths).join(', '));
  });

  test('two same-named tables from different schemas get distinct routes', function () {
    // Verified live: before the graph carried schemas these merged into one table with eight
    // duplicate primary-key columns, generating `/orders/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}`.
    const spec: any = buildOpenApiSpec({
      tables: [table('PUBLIC.ORDERS', 'ORDERS'), table('SALES.ORDERS')], relationships: [],
    } as any, {});
    assert.ok(spec.paths['/orders']);
    assert.ok(spec.paths['/sales.orders']);
    assert.ok(spec.paths['/orders/{ID}'], Object.keys(spec.paths).join(', '));
  });

  test('a pre-Firebird-6 graph is unaffected', function () {
    const spec: any = buildOpenApiSpec({ tables: [table('ORDERS')], relationships: [] } as any, {});
    assert.ok(spec.paths['/orders']);
  });
});

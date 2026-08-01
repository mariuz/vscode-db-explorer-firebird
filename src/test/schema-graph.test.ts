import * as assert from 'assert';
import { buildSchemaGraph, normalizeDefault, SchemaColumnRow, ForeignKeyRow } from '../schema-designer/schema-graph';

function columnRow(overrides: Partial<SchemaColumnRow> = {}): SchemaColumnRow {
  return {
    TABLE_NAME: 'PRODUCTS',
    FIELD_NAME: 'ID',
    FIELD_TYPE: 'INTEGER',
    FIELD_LENGTH: 4,
    NOT_NULL: 1,
    IS_PRIMARY_KEY: 1,
    ...overrides,
  };
}

function fkRow(overrides: Partial<ForeignKeyRow> = {}): ForeignKeyRow {
  return {
    TABLE_NAME: 'ORDERS',
    COLUMN_NAME: 'PRODUCT_ID',
    CONSTRAINT_NAME: 'FK_ORDERS_PRODUCT',
    REF_TABLE_NAME: 'PRODUCTS',
    REF_COLUMN_NAME: 'ID',
    ...overrides,
  };
}

// normalizeDefault() is exercised indirectly through buildSchemaGraph()'s default-value tests
// below, but is also reused directly by database-projects/project-model.ts (buildTableCreateDDL())
// — worth its own direct edge-case coverage rather than relying solely on that indirect exercise.
suite('normalizeDefault()', function () {
  test('strips a leading "DEFAULT " keyword', function () {
    assert.strictEqual(normalizeDefault('DEFAULT 0'), '0');
  });

  test('is case-insensitive on the "DEFAULT" keyword', function () {
    assert.strictEqual(normalizeDefault('default 0'), '0');
  });

  test('a value with no "DEFAULT" prefix passes through trimmed', function () {
    assert.strictEqual(normalizeDefault("'ACTIVE'"), "'ACTIVE'");
  });

  test('null/undefined/empty-string all normalize to undefined', function () {
    assert.strictEqual(normalizeDefault(null), undefined);
    assert.strictEqual(normalizeDefault(undefined), undefined);
    assert.strictEqual(normalizeDefault(''), undefined);
  });

  test('whitespace-only input normalizes to undefined', function () {
    assert.strictEqual(normalizeDefault('   '), undefined);
  });

  test('"DEFAULT" alone with no trailing whitespace/value is left as-is — the stripping regex requires \\s+ after the keyword, and a real RDB$DEFAULT_SOURCE is never just the bare keyword', function () {
    assert.strictEqual(normalizeDefault('DEFAULT'), 'DEFAULT');
  });

  test('trims surrounding whitespace after stripping the keyword', function () {
    assert.strictEqual(normalizeDefault('  DEFAULT   42  '), '42');
  });

  test('a multi-word expression after DEFAULT is preserved as-is', function () {
    assert.strictEqual(normalizeDefault("DEFAULT CURRENT_TIMESTAMP"), 'CURRENT_TIMESTAMP');
  });
});

suite('buildSchemaGraph', function () {

  test('returns empty tables/relationships for no input', function () {
    const graph = buildSchemaGraph([], []);
    assert.deepStrictEqual(graph.tables, []);
    assert.deepStrictEqual(graph.relationships, []);
  });

  test('groups columns under a single table', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ FIELD_NAME: 'NAME', FIELD_TYPE: 'VARCHAR', FIELD_LENGTH: 50, IS_PRIMARY_KEY: 0 }),
      ],
      []
    );
    assert.strictEqual(graph.tables.length, 1);
    assert.strictEqual(graph.tables[0].name, 'PRODUCTS');
    assert.strictEqual(graph.tables[0].columns.length, 2);
  });

  test('splits columns across multiple tables', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'ID' }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'ID' }),
      ],
      []
    );
    const names = graph.tables.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['ORDERS', 'PRODUCTS']);
  });

  test('preserves column order as given (query already orders by field position)', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ FIELD_NAME: 'ID' }),
        columnRow({ FIELD_NAME: 'NAME' }),
        columnRow({ FIELD_NAME: 'PRICE' }),
      ],
      []
    );
    assert.deepStrictEqual(graph.tables[0].columns.map(c => c.name), ['ID', 'NAME', 'PRICE']);
  });

  test('trims whitespace-padded names (Firebird CHAR fields)', function () {
    const graph = buildSchemaGraph(
      [columnRow({ TABLE_NAME: 'PRODUCTS   ', FIELD_NAME: 'ID   ', FIELD_TYPE: 'INTEGER ' })],
      []
    );
    assert.strictEqual(graph.tables[0].name, 'PRODUCTS');
    assert.strictEqual(graph.tables[0].columns[0].name, 'ID');
    assert.strictEqual(graph.tables[0].columns[0].type, 'INTEGER');
  });

  test('maps IS_PRIMARY_KEY/NOT_NULL numeric flags to booleans', function () {
    const graph = buildSchemaGraph(
      [columnRow({ IS_PRIMARY_KEY: 1, NOT_NULL: 1 }), columnRow({ FIELD_NAME: 'NOTES', IS_PRIMARY_KEY: 0, NOT_NULL: 0 })],
      []
    );
    assert.strictEqual(graph.tables[0].columns[0].isPrimaryKey, true);
    assert.strictEqual(graph.tables[0].columns[0].notNull, true);
    assert.strictEqual(graph.tables[0].columns[1].isPrimaryKey, false);
    assert.strictEqual(graph.tables[0].columns[1].notNull, false);
  });

  test('defaults a null FIELD_LENGTH to 0', function () {
    const graph = buildSchemaGraph([columnRow({ FIELD_LENGTH: null as unknown as number })], []);
    assert.strictEqual(graph.tables[0].columns[0].length, 0);
  });

  test('strips the leading DEFAULT keyword from DFLT_VALUE', function () {
    const graph = buildSchemaGraph([columnRow({ DFLT_VALUE: "DEFAULT 'NEW'" })], []);
    assert.strictEqual(graph.tables[0].columns[0].dflt, "'NEW'");
  });

  test('is case-insensitive and trims whitespace when stripping DEFAULT', function () {
    const graph = buildSchemaGraph([columnRow({ DFLT_VALUE: '  default   0  ' })], []);
    assert.strictEqual(graph.tables[0].columns[0].dflt, '0');
  });

  test('leaves dflt undefined when there is no default', function () {
    const graph = buildSchemaGraph([columnRow({ DFLT_VALUE: null })], []);
    assert.strictEqual(graph.tables[0].columns[0].dflt, undefined);
  });

  test('leaves dflt undefined for an empty-string DFLT_VALUE', function () {
    const graph = buildSchemaGraph([columnRow({ DFLT_VALUE: '   ' })], []);
    assert.strictEqual(graph.tables[0].columns[0].dflt, undefined);
  });

  test('carries FIELD_SUB_TYPE/PRECISION/SCALE through for a NUMERIC/DECIMAL column', function () {
    const graph = buildSchemaGraph([columnRow({ FIELD_SUB_TYPE: 1, FIELD_PRECISION: 9, FIELD_SCALE: -2 })], []);
    const col = graph.tables[0].columns[0];
    assert.strictEqual(col.subType, 1);
    assert.strictEqual(col.precision, 9);
    assert.strictEqual(col.scale, -2);
  });

  test('leaves subType/precision/scale undefined when the row has none (a plain, non-fixed-point column)', function () {
    const graph = buildSchemaGraph([columnRow()], []);
    const col = graph.tables[0].columns[0];
    assert.strictEqual(col.subType, undefined);
    assert.strictEqual(col.precision, undefined);
    assert.strictEqual(col.scale, undefined);
  });

  test('builds a single relationship', function () {
    const graph = buildSchemaGraph([], [fkRow()]);
    assert.strictEqual(graph.relationships.length, 1);
    assert.deepStrictEqual(graph.relationships[0], {
      constraintName: 'FK_ORDERS_PRODUCT',
      table: 'ORDERS',
      column: 'PRODUCT_ID',
      refTable: 'PRODUCTS',
      refColumn: 'ID',
    });
  });

  test('builds a composite-key relationship as two relationship entries sharing a constraint name', function () {
    const graph = buildSchemaGraph(
      [],
      [
        fkRow({ COLUMN_NAME: 'ORDER_YEAR', REF_COLUMN_NAME: 'YEAR' }),
        fkRow({ COLUMN_NAME: 'ORDER_SEQ', REF_COLUMN_NAME: 'SEQ' }),
      ]
    );
    assert.strictEqual(graph.relationships.length, 2);
    assert.strictEqual(graph.relationships[0].constraintName, graph.relationships[1].constraintName);
    assert.deepStrictEqual(graph.relationships.map(r => r.column), ['ORDER_YEAR', 'ORDER_SEQ']);
  });

  test('a table with no foreign keys still appears with an empty relationships contribution', function () {
    const graph = buildSchemaGraph([columnRow({ TABLE_NAME: 'STANDALONE' })], []);
    assert.strictEqual(graph.tables.length, 1);
    assert.strictEqual(graph.relationships.length, 0);
  });

  test('trims whitespace on relationship fields too', function () {
    const graph = buildSchemaGraph(
      [],
      [fkRow({ TABLE_NAME: 'ORDERS ', COLUMN_NAME: ' PRODUCT_ID', REF_TABLE_NAME: 'PRODUCTS ', REF_COLUMN_NAME: ' ID' })]
    );
    assert.strictEqual(graph.relationships[0].table, 'ORDERS');
    assert.strictEqual(graph.relationships[0].column, 'PRODUCT_ID');
    assert.strictEqual(graph.relationships[0].refTable, 'PRODUCTS');
    assert.strictEqual(graph.relationships[0].refColumn, 'ID');
  });

  test('a full multi-table schema assembles tables and relationships independently', function () {
    const graph = buildSchemaGraph(
      [
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ TABLE_NAME: 'PRODUCTS', FIELD_NAME: 'NAME', IS_PRIMARY_KEY: 0 }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'ID', IS_PRIMARY_KEY: 1 }),
        columnRow({ TABLE_NAME: 'ORDERS', FIELD_NAME: 'PRODUCT_ID', IS_PRIMARY_KEY: 0 }),
      ],
      [fkRow()]
    );
    assert.strictEqual(graph.tables.length, 2);
    assert.strictEqual(graph.relationships.length, 1);
    const orders = graph.tables.find(t => t.name === 'ORDERS')!;
    assert.strictEqual(orders.columns.length, 2);
  });
});

suite('buildSchemaGraph() — Firebird 6 schemas (docs/roadmap/firebird6-schemas.md)', function () {
  const col = (schema: string | undefined, table: string, field: string) => ({
    SCHEMA_NAME: schema,
    TABLE_NAME: table,
    FIELD_NAME: field,
    FIELD_TYPE: 'INTEGER',
    FIELD_LENGTH: 4,
    NOT_NULL: 0,
    IS_PRIMARY_KEY: 0,
  });

  test('same-named tables in different schemas stay separate boxes', function () {
    // Verified live: keyed by bare name, SALES.ORDERS and PUBLIC.ORDERS merged into one box
    // holding the union of their columns — a table that exists nowhere.
    const graph = buildSchemaGraph(
      [col('SALES', 'ORDERS', 'TOTAL'), col('PUBLIC', 'ORDERS', 'NOTE')] as any,
      []
    );
    assert.deepStrictEqual(graph.tables.map(t => t.name).sort(), ['PUBLIC.ORDERS', 'SALES.ORDERS']);
    assert.deepStrictEqual(graph.tables.find(t => t.name === 'SALES.ORDERS')!.columns.map(c => c.name), ['TOTAL']);
  });

  test('rows without a schema keep their bare name, so pre-6 servers are unaffected', function () {
    const graph = buildSchemaGraph([col(undefined, 'ORDERS', 'NOTE')] as any, []);
    assert.deepStrictEqual(graph.tables.map(t => t.name), ['ORDERS']);
  });

  test('each end of a relationship is qualified independently', function () {
    // A foreign key may reference a table in another schema, so the two sides can differ.
    const graph = buildSchemaGraph([], [{
      SCHEMA_NAME: 'SALES', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'CUST_ID',
      CONSTRAINT_NAME: 'FK', REF_SCHEMA_NAME: 'PUBLIC', REF_TABLE_NAME: 'CUST', REF_COLUMN_NAME: 'ID',
    }] as any);
    assert.strictEqual(graph.relationships[0].table, 'SALES.ORDERS');
    assert.strictEqual(graph.relationships[0].refTable, 'PUBLIC.CUST');
  });
});

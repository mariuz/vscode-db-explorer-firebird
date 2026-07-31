import * as assert from 'assert';
import { copilotScopingPrompt, parseTableAccessResponse, ScopingTable } from '../data-api-builder';
import { buildOpenApiSpec } from '../data-api-builder/openapi-spec';
import { SchemaTable } from '../schema-designer/schema-graph';

/** Phase 5 widened these two functions from bare table names to name+columns; this keeps the
 *  pre-existing cases readable without restating columns none of them care about. */
function scoping(...names: string[]): ScopingTable[] {
  return names.map(name => ({ name, columns: ['ID', 'NAME'] }));
}

// ── copilotScopingPrompt() ────────────────────────────────────────────────────
//
// Data API Builder phase 3 (docs/roadmap/data-api-builder.md): Copilot-assisted scoping asks the
// model for a small structured JSON decision (which tables, "full" vs "read-only") rather than a
// raw OpenAPI spec — buildOpenApiSpec() (already proven) turns that into the actual spec.

suite('data-api-builder – copilotScopingPrompt()', function () {
  test('lists every available table name', function () {
    const prompt = copilotScopingPrompt(scoping('CUSTOMERS', 'ORDERS', 'LOG'), 'expose customers read-only');
    assert.ok(prompt.includes('- CUSTOMERS: ID, NAME'), prompt);
    assert.ok(prompt.includes('- ORDERS: ID, NAME'), prompt);
    assert.ok(prompt.includes('- LOG: ID, NAME'), prompt);
  });

  test('includes the user\'s instruction verbatim', function () {
    const prompt = copilotScopingPrompt(scoping('CUSTOMERS'), 'expose customers and orders as read-only');
    assert.ok(prompt.includes('expose customers and orders as read-only'), prompt);
  });

  test('asks for the exact {"tables": {...}} JSON shape, no markdown fence', function () {
    const prompt = copilotScopingPrompt(scoping('A'), 'x');
    assert.ok(prompt.includes('"tables"'), prompt);
    assert.ok(prompt.includes('no markdown fence'), prompt);
  });
});

// ── parseTableAccessResponse() ────────────────────────────────────────────────

suite('data-api-builder – parseTableAccessResponse()', function () {
  const knownTables = scoping('CUSTOMERS', 'ORDERS', 'LOG');

  test('parses a clean {"tables": {...}} response', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"read-only","ORDERS":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'read-only', ORDERS: 'full' });
  });

  test('strips a ```json fence, matching extractJson()', function () {
    const result = parseTableAccessResponse('```json\n{"tables":{"CUSTOMERS":"full"}}\n```', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('normalizes case against the real table name, not whatever casing the model used', function () {
    const result = parseTableAccessResponse('{"tables":{"customers":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('drops a hallucinated/misspelled table name rather than trusting it', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"full","NONEXISTENT_TABLE":"full"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full' });
  });

  test('treats any access value other than exactly "read-only" as "full"', function () {
    const result = parseTableAccessResponse('{"tables":{"CUSTOMERS":"readonly","ORDERS":"something-else"}}', knownTables);
    assert.deepStrictEqual(result, { CUSTOMERS: 'full', ORDERS: 'full' });
  });

  test('returns an empty object when every named table is unrecognized', function () {
    const result = parseTableAccessResponse('{"tables":{"NOPE":"full"}}', knownTables);
    assert.deepStrictEqual(result, {});
  });

  test('returns an empty object for an explicitly empty tables map (Copilot decided nothing matched)', function () {
    const result = parseTableAccessResponse('{"tables":{}}', knownTables);
    assert.deepStrictEqual(result, {});
  });

  test('throws with the raw response included when the model did not return valid JSON', function () {
    assert.throws(() => parseTableAccessResponse('Sure, here you go: not json', knownTables), /Copilot didn't return valid JSON/);
  });

  test('throws when the JSON is valid but missing the "tables" key', function () {
    assert.throws(() => parseTableAccessResponse('{"foo":"bar"}', knownTables), /expected \{"tables": \{\.\.\.\}\} shape/);
  });

  test('throws when "tables" is not an object', function () {
    assert.throws(() => parseTableAccessResponse('{"tables":"CUSTOMERS"}', knownTables), /expected \{"tables": \{\.\.\.\}\} shape/);
  });
});

// ── phase 5: column-level include/exclude ─────────────────────────────────────

suite('data-api-builder – column scoping (docs/roadmap/data-api-builder.md, phase 5)', function () {
  const usersTable: SchemaTable = {
    name: 'USERS',
    columns: [
      { name: 'ID', type: 'INTEGER', length: 4, notNull: true, isPrimaryKey: true },
      { name: 'EMAIL', type: 'VARCHAR', length: 120, notNull: true, isPrimaryKey: false, dflt: "''" },
      { name: 'PASSWORD_HASH', type: 'VARCHAR', length: 60, notNull: true, isPrimaryKey: false },
      { name: 'NICKNAME', type: 'VARCHAR', length: 40, notNull: false, isPrimaryKey: false },
    ],
  } as SchemaTable;

  const graph = { tables: [usersTable], foreignKeys: [] } as any;

  test('excludeColumns keeps a column out of the generated schema', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'read-only', excludeColumns: ['PASSWORD_HASH'] } },
    });
    const properties = spec.components.schemas.USERS.properties;
    assert.deepStrictEqual(Object.keys(properties), ['ID', 'EMAIL', 'NICKNAME']);
    assert.ok(!JSON.stringify(spec).includes('PASSWORD_HASH'), 'the hidden column must not appear anywhere in the spec');
  });

  test('includeColumns is an allow-list and wins over excludeColumns', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'read-only', includeColumns: ['ID', 'NICKNAME'], excludeColumns: ['ID'] } },
    });
    assert.deepStrictEqual(Object.keys(spec.components.schemas.USERS.properties), ['ID', 'NICKNAME']);
  });

  test('column names are matched case-insensitively, and unknown names are ignored', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'read-only', excludeColumns: ['password_hash', 'NO_SUCH_COLUMN'] } },
    });
    assert.deepStrictEqual(Object.keys(spec.components.schemas.USERS.properties), ['ID', 'EMAIL', 'NICKNAME']);
  });

  test('hiding a NOT NULL column with no default downgrades the table to read-only', function () {
    // A POST body could never satisfy PASSWORD_HASH, so emitting a create route would guarantee a
    // server-side failure on every call.
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'full', excludeColumns: ['PASSWORD_HASH'] } },
    });
    assert.deepStrictEqual(Object.keys(spec.paths['/users']), ['get'], 'no POST when a mandatory column is hidden');
    assert.ok(!('put' in spec.paths['/users/{ID}']), 'no PUT either');
    assert.ok(!('delete' in spec.paths['/users/{ID}']));
  });

  test('hiding a NOT NULL column that has a default keeps full access — the database fills it in', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'full', excludeColumns: ['EMAIL'] } },
    });
    assert.ok('post' in spec.paths['/users'], 'EMAIL has a default, so a create is still satisfiable');
    assert.ok('put' in spec.paths['/users/{ID}']);
  });

  test('hiding a nullable column leaves full access untouched', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'full', excludeColumns: ['NICKNAME'] } },
    });
    assert.ok('post' in spec.paths['/users']);
    assert.ok(!('NICKNAME' in spec.components.schemas.USERS.properties));
  });

  test('hiding a primary-key column drops the by-PK routes but keeps the list route', function () {
    // The item path template is built from the PK columns; without them there's no addressable route.
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'read-only', excludeColumns: ['ID'] } },
    });
    assert.ok('/users' in spec.paths, 'the list route survives');
    assert.ok(!Object.keys(spec.paths).some(p => p.includes('{')), `no by-PK route expected, got ${Object.keys(spec.paths)}`);
  });

  test('a table with every column hidden is left out of the spec entirely', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'full', excludeColumns: ['ID', 'EMAIL', 'PASSWORD_HASH', 'NICKNAME'] } },
    });
    assert.deepStrictEqual(spec.paths, {});
    assert.deepStrictEqual(spec.components.schemas, {});
  });

  test('the bare access-level string still behaves exactly as before phase 5', function () {
    const withString = buildOpenApiSpec(graph, { tableAccess: { USERS: 'full' } });
    const withObject = buildOpenApiSpec(graph, { tableAccess: { USERS: { access: 'full' } } });
    assert.deepStrictEqual(withString, withObject);
    assert.deepStrictEqual(Object.keys(withString.components.schemas.USERS.properties), ['ID', 'EMAIL', 'PASSWORD_HASH', 'NICKNAME']);
  });

  test('required lists only the visible NOT NULL columns', function () {
    const spec = buildOpenApiSpec(graph, {
      tableAccess: { USERS: { access: 'read-only', excludeColumns: ['PASSWORD_HASH'] } },
    });
    assert.deepStrictEqual(spec.components.schemas.USERS.required, ['ID', 'EMAIL']);
  });
});

suite('data-api-builder – parseTableAccessResponse() column scoping (phase 5)', function () {
  const known: ScopingTable[] = [{ name: 'USERS', columns: ['ID', 'EMAIL', 'PASSWORD_HASH'] }];

  test('parses the object form with excludeColumns', function () {
    const result = parseTableAccessResponse('{"tables":{"USERS":{"access":"read-only","excludeColumns":["PASSWORD_HASH"]}}}', known);
    assert.deepStrictEqual(result, { USERS: { access: 'read-only', includeColumns: undefined, excludeColumns: ['PASSWORD_HASH'] } });
  });

  test('column names are validated against the real ones, and normalized to their real casing', function () {
    const result = parseTableAccessResponse('{"tables":{"USERS":{"access":"full","excludeColumns":["password_hash","INVENTED_COLUMN"]}}}', known);
    assert.deepStrictEqual((result.USERS as any).excludeColumns, ['PASSWORD_HASH']);
  });

  test('an entry whose columns all fail validation falls back to the bare access level', function () {
    // Not an object with empty lists — that would read as "an allow-list matching nothing".
    const result = parseTableAccessResponse('{"tables":{"USERS":{"access":"read-only","excludeColumns":["NOPE"]}}}', known);
    assert.strictEqual(result.USERS, 'read-only');
  });

  test('the bare string form is still accepted alongside the object form', function () {
    const result = parseTableAccessResponse('{"tables":{"USERS":"full"}}', known);
    assert.strictEqual(result.USERS, 'full');
  });

  test('a malformed object entry degrades to full access rather than throwing', function () {
    const result = parseTableAccessResponse('{"tables":{"USERS":{"access":"nonsense","excludeColumns":"not-an-array"}}}', known);
    assert.strictEqual(result.USERS, 'full');
  });
});

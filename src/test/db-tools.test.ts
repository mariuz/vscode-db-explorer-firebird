import * as assert from 'assert';
import {
  getQueryPlanTool,
  getSchemaTool,
  listConnectionsTool,
  runQueryTool,
  runWriteQueryTool,
  ToolConnectionInfo,
  ToolExecutor,
  ToolQueryFn,
  WriteAuditEntry,
} from '../shared/db-tools';

/**
 * These five tool bodies lived inline in the MCP subprocess until
 * docs/roadmap/language-model-tools.md's phase 1 extracted them behind `ToolExecutor` — which is
 * what makes them testable here at all, with no database, no MCP client, and no extension host.
 */

const CONNECTIONS: ToolConnectionInfo[] = [
  { id: 'read-only', label: 'Read Only', host: 'localhost', database: '/tmp/ro.fdb', writeEnabled: false },
  { id: 'writable', label: 'Writable', host: 'localhost', database: '/tmp/rw.fdb', writeEnabled: true },
];

interface FakeExecutor extends ToolExecutor {
  statements: { connectionId: string; sql: string; params?: any[] }[];
  audits: WriteAuditEntry[];
  connectCount: number;
}

/**
 * `rows` is either a fixed result for every statement, a function of the statement, or an Error to
 * throw from the query itself (as opposed to from connecting).
 */
function fakeExecutor(rows?: any[] | ((sql: string) => any[] | undefined | Error)): FakeExecutor {
  const executor: FakeExecutor = {
    statements: [],
    audits: [],
    connectCount: 0,

    async listConnections() {
      return CONNECTIONS;
    },

    async withConnection<T>(connectionId: string, run: (query: ToolQueryFn) => Promise<T>): Promise<T> {
      executor.connectCount++;
      const query: ToolQueryFn = async (sql, params) => {
        executor.statements.push({ connectionId, sql, params });
        const result = typeof rows === 'function' ? rows(sql) : rows;
        if (result instanceof Error) { throw result; }
        return result;
      };
      return run(query);
    },

    audit(entry) {
      executor.audits.push(entry);
    },
  };
  return executor;
}

suite('db-tools – connection resolution (docs/roadmap/language-model-tools.md, phase 1)', function () {

  test('list_connections returns every connection, including the writeEnabled flag', async function () {
    const outcome = await listConnectionsTool(fakeExecutor());
    assert.strictEqual(outcome.isError, undefined);
    assert.deepStrictEqual(JSON.parse(outcome.text), CONNECTIONS);
  });

  test('every id-taking tool refuses an unknown connection id with the same guidance, and never connects', async function () {
    for (const run of [
      (e: FakeExecutor) => getSchemaTool(e, 'nope'),
      (e: FakeExecutor) => runQueryTool(e, 'nope', 'SELECT 1 FROM RDB$DATABASE'),
      (e: FakeExecutor) => getQueryPlanTool(e, 'nope', 'SELECT 1 FROM RDB$DATABASE'),
      (e: FakeExecutor) => runWriteQueryTool(e, 'nope', 'DELETE FROM T'),
    ]) {
      const executor = fakeExecutor();
      const outcome = await run(executor);
      assert.strictEqual(outcome.isError, true);
      assert.ok(outcome.text.includes('list_connections'), outcome.text);
      assert.strictEqual(executor.connectCount, 0, 'must not open a connection for an unknown id');
    }
  });

  test('an unknown connection id is not audited — nothing reached a database to record', async function () {
    const executor = fakeExecutor();
    await runWriteQueryTool(executor, 'nope', 'DELETE FROM T');
    assert.deepStrictEqual(executor.audits, []);
  });
});

suite('db-tools – get_schema', function () {

  test('both metadata queries run on one connection, and the result is a schema graph', async function () {
    const executor = fakeExecutor(sql => (sql.includes('RDB$RELATION_CONSTRAINTS') ? [] : []));
    const outcome = await getSchemaTool(executor, 'read-only');
    assert.strictEqual(outcome.isError, undefined);
    assert.strictEqual(executor.statements.length, 2, 'columns query + foreign keys query');
    assert.strictEqual(executor.connectCount, 1, 'both statements must share one connection');
    assert.ok('tables' in JSON.parse(outcome.text));
  });

  test('a failure is reported as a tool error rather than thrown at the caller', async function () {
    const outcome = await getSchemaTool(fakeExecutor(() => new Error('boom')), 'read-only');
    assert.strictEqual(outcome.isError, true);
    assert.ok(outcome.text.startsWith('Could not fetch schema:'), outcome.text);
    assert.ok(outcome.text.includes('boom'), outcome.text);
  });
});

suite('db-tools – run_query is read-only', function () {

  test('a SELECT runs and its rows come back as JSON', async function () {
    const executor = fakeExecutor([{ N: 5 }]);
    const outcome = await runQueryTool(executor, 'read-only', 'SELECT COUNT(*) AS N FROM PRODUCTS');
    assert.strictEqual(outcome.isError, undefined);
    assert.deepStrictEqual(JSON.parse(outcome.text), [{ N: 5 }]);
  });

  test('a statement with no result set reports an empty array rather than "undefined"', async function () {
    const outcome = await runQueryTool(fakeExecutor(undefined), 'read-only', 'SELECT 1 FROM RDB$DATABASE');
    assert.deepStrictEqual(JSON.parse(outcome.text), []);
  });

  test('writes and DDL are refused before any connection is opened', async function () {
    for (const sql of [
      'DELETE FROM PRODUCTS',
      'UPDATE PRODUCTS SET NAME = \'x\'',
      'INSERT INTO PRODUCTS (NAME) VALUES (\'x\')',
      'DROP TABLE PRODUCTS',
      'EXECUTE BLOCK AS BEGIN DELETE FROM PRODUCTS; END',
    ]) {
      const executor = fakeExecutor();
      const outcome = await runQueryTool(executor, 'read-only', sql);
      assert.strictEqual(outcome.isError, true, sql);
      assert.strictEqual(executor.connectCount, 0, `must refuse ${sql} without connecting`);
    }
  });

  test('a query failure is reported as a tool error, not thrown', async function () {
    const outcome = await runQueryTool(fakeExecutor(() => new Error('Token unknown')), 'read-only', 'SELECT 1 FROM RDB$DATABASE');
    assert.strictEqual(outcome.isError, true);
    assert.ok(outcome.text.startsWith('Query failed:'), outcome.text);
  });
});

suite('db-tools – get_query_plan', function () {

  test('a statement naming no recognizable table renders a plan without connecting at all', async function () {
    // No FROM clause, so extractTableNames() finds nothing to look indexes up for. (`SELECT 1 FROM
    // RDB$DATABASE` would *not* qualify — RDB$DATABASE is a real table name and does get looked up.)
    const executor = fakeExecutor();
    const outcome = await getQueryPlanTool(executor, 'read-only', 'SELECT CURRENT_TIMESTAMP');
    assert.strictEqual(outcome.isError, undefined);
    assert.strictEqual(executor.connectCount, 0);
  });

  test('a statement naming a table looks its indexes up, passing the table names as parameters', async function () {
    const executor = fakeExecutor([]);
    const outcome = await getQueryPlanTool(executor, 'read-only', 'SELECT * FROM PRODUCTS WHERE ID = 1');
    assert.strictEqual(outcome.isError, undefined);
    assert.strictEqual(executor.statements.length, 1);
    assert.deepStrictEqual(executor.statements[0].params, ['PRODUCTS']);
  });

  test('it enforces the same read-only restriction as run_query', async function () {
    const outcome = await getQueryPlanTool(fakeExecutor(), 'read-only', 'DELETE FROM PRODUCTS');
    assert.strictEqual(outcome.isError, true);
  });
});

suite('db-tools – run_write_query gate and audit trail', function () {

  test('a connection without write access is refused, and the refusal is audited', async function () {
    const executor = fakeExecutor();
    const outcome = await runWriteQueryTool(executor, 'read-only', 'DELETE FROM PRODUCTS WHERE ID = 1');
    assert.strictEqual(outcome.isError, true);
    assert.ok(outcome.text.includes('Toggle MCP Server Write Access'), outcome.text);
    assert.strictEqual(executor.connectCount, 0, 'a refused write must never reach the database');
    assert.deepStrictEqual(executor.audits, [{
      connectionId: 'read-only',
      sql: 'DELETE FROM PRODUCTS WHERE ID = 1',
      success: false,
      error: outcome.text,
    }]);
  });

  test('a non-write statement is refused even on a write-enabled connection, and audited', async function () {
    const executor = fakeExecutor();
    const outcome = await runWriteQueryTool(executor, 'writable', 'SELECT * FROM PRODUCTS');
    assert.strictEqual(outcome.isError, true);
    assert.strictEqual(executor.connectCount, 0);
    assert.strictEqual(executor.audits.length, 1);
    assert.strictEqual(executor.audits[0].success, false);
  });

  test('a permitted write runs, is audited as a success, and reports plainly when there are no rows', async function () {
    const executor = fakeExecutor(undefined);
    const outcome = await runWriteQueryTool(executor, 'writable', 'DELETE FROM PRODUCTS WHERE ID = 1');
    assert.strictEqual(outcome.isError, undefined);
    assert.strictEqual(outcome.text, 'Statement executed successfully.');
    assert.deepStrictEqual(executor.audits, [{
      connectionId: 'writable',
      sql: 'DELETE FROM PRODUCTS WHERE ID = 1',
      success: true,
    }]);
  });

  test('a RETURNING clause\'s rows are surfaced instead of the plain success message', async function () {
    const executor = fakeExecutor([{ ID: 7 }]);
    const outcome = await runWriteQueryTool(executor, 'writable', 'INSERT INTO PRODUCTS (NAME) VALUES (\'x\') RETURNING ID');
    assert.deepStrictEqual(JSON.parse(outcome.text), [{ ID: 7 }]);
    assert.strictEqual(executor.audits[0].success, true);
  });

  test('a failed write is audited with its error, not silently dropped', async function () {
    const executor = fakeExecutor(() => new Error('violation of FOREIGN KEY constraint'));
    const outcome = await runWriteQueryTool(executor, 'writable', 'DELETE FROM PRODUCTS WHERE ID = 1');
    assert.strictEqual(outcome.isError, true);
    assert.ok(outcome.text.startsWith('Write failed:'), outcome.text);
    assert.strictEqual(executor.audits.length, 1);
    assert.strictEqual(executor.audits[0].success, false);
    assert.ok(executor.audits[0].error?.includes('FOREIGN KEY'));
  });

  test('an executor with no audit() does not break any path — auditing is best-effort', async function () {
    const bare: ToolExecutor = {
      async listConnections() { return CONNECTIONS; },
      async withConnection(_id, run) { return run(async () => undefined); },
    };
    assert.strictEqual((await runWriteQueryTool(bare, 'writable', 'DELETE FROM T')).text, 'Statement executed successfully.');
    assert.strictEqual((await runWriteQueryTool(bare, 'read-only', 'DELETE FROM T')).isError, true);
  });
});

import * as assert from "assert";
import { KeywordsDb, SCHEMA_CACHE_TTL_MS } from "../language-server/db-words.provider";
import { Driver } from "../shared/driver";
import { Global } from "../shared/global";

/**
 * Completion and hover share one schema handler, and it had no cache and never released its
 * connection. Measured against a live server on a ten-table database, three consecutive
 * completions opened three connections and issued six catalogue queries. These pin both halves of
 * the fix with a counting fake, so the regression is caught without a server.
 */
suite("Completion schema cache", function () {
  let connections = 0, queries = 0, detaches = 0;
  const previousClient = Driver.client;
  const previousConnection = (Global as any).activeConnection;

  function installFakeClient(): void {
    connections = 0; queries = 0; detaches = 0;
    Driver.client = {
      createConnection: async () => { connections++; return { id: connections } as any; },
      detach: async () => { detaches++; },
      queryPromise: async (_c: any, sql: string) => {
        queries++;
        if (/RDB\$RELATIONS|TABLE_NAME/i.test(sql) && !/RDB\$RELATION_FIELDS/i.test(sql)) {
          return [{ TABLE_NAME: "ORDERS  ", SCHEMA_NAME: null }] as any;
        }
        if (/RDB\$RELATION_FIELDS|FIELD_TYPE/i.test(sql)) {
          return [{ TBL: "ORDERS", FIELD: "ID  ", FIELD_TYPE: "INTEGER ", FIELD_LENGTH: 4, SCHEMA_NAME: null }] as any;
        }
        // The engine-version probe.
        return [{ VERSION: "WI-V5.0.0.0" }] as any;
      },
    } as any;
    (Driver as any).resolvePassword = async (c: any) => c;
    (Global as any).activeConnection = {
      id: "cache-test", host: "h", port: 3050, database: "d.fdb", user: "u", password: "p", role: null,
    };
  }

  setup(installFakeClient);

  suiteTeardown(function () {
    Driver.client = previousClient;
    (Global as any).activeConnection = previousConnection;
  });

  test("the first call builds, and the second is served from cache without touching the server", async function () {
    const db = new KeywordsDb();
    const first = await db.getSchema(1_000);
    const afterFirst = { connections, queries };
    assert.ok(afterFirst.connections >= 1, "the first call should connect");

    const second = await db.getSchema(1_000 + 5);
    assert.strictEqual(connections, afterFirst.connections, "the second call should not connect");
    assert.strictEqual(queries, afterFirst.queries, "the second call should issue no queries");
    assert.strictEqual(second, first, "the same schema object should be handed back");
  });

  // Every other path through Driver detaches in a finally; this one never did, so each completion
  // leaked an attachment. With pooling on, detach() is what returns it to the pool.
  test("every connection it opens is released", async function () {
    const db = new KeywordsDb();
    await db.getSchema(1_000);
    await db.getSchema(1_000 + SCHEMA_CACHE_TTL_MS);   // forces a rebuild
    assert.strictEqual(detaches, connections, `opened ${connections}, released ${detaches}`);
  });

  test("the cache expires, so a table created elsewhere appears without a restart", async function () {
    const db = new KeywordsDb();
    await db.getSchema(1_000);
    const afterFirst = connections;
    await db.getSchema(1_000 + SCHEMA_CACHE_TTL_MS - 1);
    assert.strictEqual(connections, afterFirst, "still inside the TTL");
    await db.getSchema(1_000 + SCHEMA_CACHE_TTL_MS);
    assert.strictEqual(connections, afterFirst + 1, "past the TTL it should rebuild");
  });

  test("invalidate() rebuilds immediately, which is what a tree refresh needs", async function () {
    const db = new KeywordsDb();
    await db.getSchema(1_000);
    const afterFirst = connections;
    db.invalidate();
    await db.getSchema(1_000 + 5);
    assert.strictEqual(connections, afterFirst + 1);
  });

  test("switching the active connection misses the cache, without anyone calling invalidate()", async function () {
    const db = new KeywordsDb();
    await db.getSchema(1_000);
    const afterFirst = connections;
    (Global as any).activeConnection = { ...(Global as any).activeConnection, id: "a-different-one" };
    await db.getSchema(1_000 + 5);
    assert.strictEqual(connections, afterFirst + 1, "a different connection must not be served the first one's tables");
  });

  test("a failed build does not poison the cache — the next call tries again", async function () {
    const db = new KeywordsDb();
    Driver.client = {
      createConnection: async () => { connections++; throw new Error("server unreachable"); },
      detach: async () => { detaches++; },
      queryPromise: async () => [] as any,
    } as any;

    const schema = await db.getSchema(1_000);
    assert.deepStrictEqual(schema.tables, [], "a failure degrades to keywords only");
    const afterFirst = connections;

    installFakeClient();
    connections = afterFirst;   // keep counting from where we were
    const retried = await db.getSchema(1_000 + 5);
    assert.ok(connections > afterFirst, "the next call should try the server again");
    assert.strictEqual(retried.tables.length, 1);
  });
});

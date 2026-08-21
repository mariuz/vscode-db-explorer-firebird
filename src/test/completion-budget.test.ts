import * as assert from "assert";
import {
  withTimeout, resolveCompletionTimeoutMs, DEFAULT_COMPLETION_TIMEOUT_MS
} from "../language-server/completion-budget";
import { schemaCacheKey } from "../language-server/db-words.provider";

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

suite("resolveCompletionTimeoutMs()", function () {
  test("accepts a sensible number", function () {
    assert.strictEqual(resolveCompletionTimeoutMs(500), 500);
  });

  test("zero is preserved — it means wait as long as it takes, the old behaviour", function () {
    assert.strictEqual(resolveCompletionTimeoutMs(0), 0);
  });

  test("a fractional value is floored rather than handed to setTimeout as-is", function () {
    assert.strictEqual(resolveCompletionTimeoutMs(250.7), 250);
  });

  test("anything a settings file could hold falls back to the default", function () {
    for (const bad of [-1, NaN, Infinity, "3000", null, undefined, {}, []]) {
      assert.strictEqual(resolveCompletionTimeoutMs(bad), DEFAULT_COMPLETION_TIMEOUT_MS, String(bad));
    }
  });
});

suite("withTimeout()", function () {
  test("passes through a value that arrives in time", async function () {
    assert.strictEqual(await withTimeout(Promise.resolve("fast"), 1000, () => "fallback"), "fast");
  });

  test("falls back when the work is too slow", async function () {
    const slow = tick(200).then(() => "slow");
    assert.strictEqual(await withTimeout(slow, 20, () => "fallback"), "fallback");
  });

  // The slow work is deliberately not cancelled: a query already in flight has to be read to
  // completion before its connection is reusable. It keeps running and fills the cache, so the
  // completion after a slow one is the one that benefits.
  test("the slow work still completes after the fallback was returned", async function () {
    let finished = false;
    const slow = tick(60).then(() => { finished = true; return "slow"; });
    assert.strictEqual(await withTimeout(slow, 10, () => "fallback"), "fallback");
    assert.strictEqual(finished, false, "should not have finished yet");
    await tick(80);
    assert.strictEqual(finished, true, "the abandoned work should still have run to completion");
  });

  test("a rejection is the same outcome as a timeout — no tables, not a thrown completion", async function () {
    const failed = Promise.reject(new Error("server went away"));
    assert.strictEqual(await withTimeout(failed, 1000, () => "fallback"), "fallback");
  });

  test("a zero timeout waits indefinitely rather than falling back immediately", async function () {
    const slow = tick(30).then(() => "slow");
    assert.strictEqual(await withTimeout(slow, 0, () => "fallback"), "slow");
  });

  test("resolves exactly once — a fallback already returned is not overwritten by the late value", async function () {
    let resolutions = 0;
    const slow = tick(40).then(() => "slow");
    const out = await withTimeout(slow, 10, () => "fallback");
    resolutions++;
    await tick(60);
    assert.strictEqual(out, "fallback");
    assert.strictEqual(resolutions, 1);
  });
});

suite("schemaCacheKey()", function () {
  const opts = { codeCompletionKeywords: true, codeCompletionDatabase: true, maxTablesCount: 100 };

  test("two calls for the same connection and settings agree", function () {
    assert.strictEqual(schemaCacheKey({ id: "a" }, opts), schemaCacheKey({ id: "a" }, opts));
  });

  test("a different connection is a different key, so switching connections cannot serve stale tables", function () {
    assert.notStrictEqual(schemaCacheKey({ id: "a" }, opts), schemaCacheKey({ id: "b" }, opts));
  });

  // The default schema changes what the catalogue queries return on Firebird 6, so it has to be
  // part of the key -- the same reason the connection pool keys idle sessions by it.
  test("the default schema is part of the key", function () {
    assert.notStrictEqual(
      schemaCacheKey({ id: "a", defaultSchema: "SALES" }, opts),
      schemaCacheKey({ id: "a", defaultSchema: "PUBLIC" }, opts)
    );
    assert.strictEqual(
      schemaCacheKey({ id: "a" }, opts),
      schemaCacheKey({ id: "a", defaultSchema: undefined }, opts)
    );
  });

  test("each completion setting that changes what is built changes the key", function () {
    assert.notStrictEqual(schemaCacheKey({ id: "a" }, opts), schemaCacheKey({ id: "a" }, { ...opts, codeCompletionKeywords: false }));
    assert.notStrictEqual(schemaCacheKey({ id: "a" }, opts), schemaCacheKey({ id: "a" }, { ...opts, codeCompletionDatabase: false }));
    assert.notStrictEqual(schemaCacheKey({ id: "a" }, opts), schemaCacheKey({ id: "a" }, { ...opts, maxTablesCount: 50 }));
  });
});

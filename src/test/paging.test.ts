/**
 * Server-side paging analysis — docs/roadmap/large-result-sets.md, phase 2.
 *
 * Every "Firebird accepts/rejects this" claim below was checked against a live Firebird 6.0.0
 * server before being encoded here, because the whole feature rests on which statements can safely
 * have a window appended to them. The two that matter most:
 *
 *   SELECT FIRST 10 ID FROM BIGT OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY
 *     -> SQL error -104: "FIRST/SKIP cannot be used with OFFSET/FETCH or ROWS"
 *   SELECT ID FROM BIGT -- note
 *   OFFSET 3 ROWS FETCH NEXT 2 ROWS ONLY
 *     -> works, but only because the window is on its own line
 */

import * as assert from "assert";
import { analyzePaging, buildPagedQuery, PAGING_MIN_ENGINE_VERSION } from "../shared/sql-analysis";

const FB = 6;

suite("analyzePaging – what can be paged", function () {
  test("a plain SELECT can be paged", function () {
    const result = analyzePaging("SELECT * FROM ORDERS", FB);
    assert.strictEqual(result.pageable, true);
    assert.strictEqual(result.reason, undefined);
  });

  test("a WITH … SELECT can be paged — the window goes after the final SELECT", function () {
    // Verified live: WITH C AS (SELECT ID FROM BIGT) SELECT ID FROM C ORDER BY ID
    // OFFSET 100 ROWS FETCH NEXT 5 ROWS ONLY returned ids 101–105.
    const result = analyzePaging("WITH C AS (SELECT ID FROM BIGT) SELECT ID FROM C ORDER BY ID", FB);
    assert.strictEqual(result.pageable, true);
    assert.strictEqual(result.ordered, true);
  });

  test("a UNION can be paged — the window applies to the whole union", function () {
    const sql = "SELECT ID FROM A WHERE ID < 10 UNION ALL SELECT ID FROM B WHERE ID > 90";
    assert.strictEqual(analyzePaging(sql, FB).pageable, true);
  });

  test("DML is refused", function () {
    for (const sql of ["UPDATE T SET X = 1", "DELETE FROM T", "INSERT INTO T VALUES (1)"]) {
      const result = analyzePaging(sql, FB);
      assert.strictEqual(result.pageable, false, sql);
      assert.ok(/Only SELECT/.test(result.reason!), result.reason);
    }
  });

  test("EXECUTE BLOCK is refused — it is not a SELECT even when it returns rows", function () {
    const sql = "EXECUTE BLOCK RETURNS (N INTEGER) AS BEGIN N = 1; SUSPEND; END";
    assert.strictEqual(analyzePaging(sql, FB).pageable, false);
  });

  test("more than one statement is refused", function () {
    const result = analyzePaging("SELECT * FROM A; SELECT * FROM B;", FB);
    assert.strictEqual(result.pageable, false);
    assert.ok(/single statement/.test(result.reason!), result.reason);
  });

  test("a statement that already limits itself is refused", function () {
    // Firebird itself rejects the combination: "FIRST/SKIP cannot be used with OFFSET/FETCH or ROWS".
    for (const sql of [
      "SELECT FIRST 10 * FROM T",
      "SELECT SKIP 5 * FROM T",
      "SELECT * FROM T ROWS 1 TO 10",
      "SELECT * FROM T OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY",
    ]) {
      const result = analyzePaging(sql, FB);
      assert.strictEqual(result.pageable, false, sql);
      assert.ok(/already limits/.test(result.reason!), `${sql}: ${result.reason}`);
    }
  });

  test("a limit inside a subquery does not disqualify the statement", function () {
    // The subquery's FIRST is not the statement's own, and Firebird has no objection to a window
    // on the outer SELECT.
    const sql = "SELECT * FROM T WHERE ID IN (SELECT FIRST 5 ID FROM U ORDER BY ID)";
    const result = analyzePaging(sql, FB);
    assert.strictEqual(result.pageable, true, result.reason);
    assert.strictEqual(result.ordered, false, "the ORDER BY belongs to the subquery, not the statement");
  });

  test("a window function's ROWS frame is not a paging clause", function () {
    const sql = "SELECT SUM(X) OVER (ORDER BY ID ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM T";
    assert.strictEqual(analyzePaging(sql, FB).pageable, true);
  });

  test("keywords inside string literals are ignored", function () {
    const sql = "SELECT 'ORDER BY x FETCH FIRST' AS NOTE FROM RDB$DATABASE";
    const result = analyzePaging(sql, FB);
    assert.strictEqual(result.pageable, true, result.reason);
    assert.strictEqual(result.ordered, false);
  });

  test("keywords inside comments are ignored", function () {
    const sql = "SELECT * FROM T -- ORDER BY ID\n/* FIRST 10 */";
    const result = analyzePaging(sql, FB);
    assert.strictEqual(result.pageable, true, result.reason);
    assert.strictEqual(result.ordered, false);
  });
});

suite("analyzePaging – order determinism", function () {
  test("a top-level ORDER BY is reported", function () {
    assert.strictEqual(analyzePaging("SELECT * FROM T ORDER BY ID", FB).ordered, true);
    assert.strictEqual(analyzePaging("SELECT * FROM T ORDER  BY  ID DESC", FB).ordered, true);
  });

  test("no ORDER BY is still pageable, but reported as unordered", function () {
    const result = analyzePaging("SELECT * FROM T", FB);
    assert.strictEqual(result.pageable, true);
    assert.strictEqual(result.ordered, false);
  });

  test("order is reported even for statements that cannot be paged", function () {
    // The caller shows a different message for "ordered but unpageable" than for a bare refusal,
    // so this field has to be meaningful regardless of `pageable`.
    const result = analyzePaging("SELECT FIRST 10 * FROM T ORDER BY ID", FB);
    assert.strictEqual(result.pageable, false);
    assert.strictEqual(result.ordered, true);
  });
});

suite("analyzePaging – engine version gate", function () {
  test(`Firebird ${PAGING_MIN_ENGINE_VERSION} and later can page`, function () {
    assert.strictEqual(analyzePaging("SELECT * FROM T", PAGING_MIN_ENGINE_VERSION).pageable, true);
  });

  test("Firebird 2.5 cannot — OFFSET/FETCH does not exist there", function () {
    const result = analyzePaging("SELECT * FROM T", 2);
    assert.strictEqual(result.pageable, false);
    assert.ok(/Firebird 3 or later/.test(result.reason!), result.reason);
  });

  test("a failed version probe (0) is treated as cannot, not as can", function () {
    // getEngineMajorVersion() returns 0 when it could not ask. Guessing "yes" would send syntax the
    // server may reject; guessing "no" only costs the feature.
    assert.strictEqual(analyzePaging("SELECT * FROM T", 0).pageable, false);
  });
});

suite("buildPagedQuery", function () {
  test("appends an OFFSET/FETCH window", function () {
    assert.strictEqual(
      buildPagedQuery("SELECT * FROM T", 100, 50),
      "SELECT * FROM T\nOFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY"
    );
  });

  test("drops a trailing semicolon", function () {
    assert.ok(buildPagedQuery("SELECT * FROM T;", 0, 10).startsWith("SELECT * FROM T\nOFFSET 0"));
  });

  test("drops trailing whitespace and a semicolon together", function () {
    assert.ok(buildPagedQuery("SELECT * FROM T ;  \n", 0, 10).startsWith("SELECT * FROM T\nOFFSET 0"));
  });

  test("puts the window on its own line, so a trailing line comment cannot swallow it", function () {
    // Verified live: with the window on the same line as `-- note` the server returns every row.
    const sql = buildPagedQuery("SELECT ID FROM BIGT -- note", 3, 2);
    assert.ok(/\n\s*OFFSET 3 ROWS/.test(sql), sql);
  });

  test("a semicolon inside a string literal is not mistaken for a terminator", function () {
    const sql = buildPagedQuery("SELECT ';' AS S FROM RDB$DATABASE", 0, 5);
    assert.ok(sql.startsWith("SELECT ';' AS S FROM RDB$DATABASE\nOFFSET 0"), sql);
  });

  test("offset 0 is allowed — it is the first page", function () {
    assert.ok(buildPagedQuery("SELECT * FROM T", 0, 10).includes("OFFSET 0 ROWS"));
  });

  test("rejects a non-integer or negative window rather than interpolating it", function () {
    assert.throws(() => buildPagedQuery("SELECT * FROM T", -1, 10), /Invalid page offset/);
    assert.throws(() => buildPagedQuery("SELECT * FROM T", 1.5, 10), /Invalid page offset/);
    assert.throws(() => buildPagedQuery("SELECT * FROM T", 0, 0), /Invalid page size/);
    assert.throws(() => buildPagedQuery("SELECT * FROM T", 0, NaN), /Invalid page size/);
  });
});

/**
 * The extension-host half of the results grid's row cap and server-side pager —
 * docs/roadmap/large-result-sets.md, phases 1 and 2.
 *
 * `capRows` had no unit test of its own before this; it is the function that decides whether a
 * result is presented as complete, so it is worth pinning independently of the note that renders
 * its verdict (covered in result-view-webview.test.ts).
 */

import * as assert from "assert";
import { capRows, buildPagingInfo } from "../result-view";

const FB6 = 6;
const PAGE = 10_000;

suite("capRows", function () {
  test("leaves a result that fits alone, with no truncation marker", function () {
    const rows = [1, 2, 3];
    const result = capRows(rows, 10);
    assert.strictEqual(result.rows, rows, "the array should be passed through untouched");
    assert.strictEqual(result.truncatedFrom, undefined);
  });

  test("trims to the cap and reports the original count", function () {
    const result = capRows(Array.from({ length: 50 }, (_, i) => i), 10);
    assert.strictEqual(result.rows.length, 10);
    assert.strictEqual(result.truncatedFrom, 50);
  });

  test("exactly the cap is not a truncation", function () {
    assert.strictEqual(capRows(Array.from({ length: 10 }), 10).truncatedFrom, undefined);
  });

  test("0 means no limit — the documented convention for these settings", function () {
    const rows = Array.from({ length: 1000 });
    assert.strictEqual(capRows(rows, 0).rows.length, 1000);
    assert.strictEqual(capRows(rows, 0).truncatedFrom, undefined);
  });

  test("a nonsense limit does not silently drop rows", function () {
    // getOptions() validates the setting, but this function is also reachable with whatever a
    // future caller passes; dropping every row on a NaN would be a very quiet failure.
    for (const bad of [NaN, -5, 1.5] as number[]) {
      assert.strictEqual(capRows([1, 2, 3], bad).rows.length, 3, `limit ${bad}`);
    }
  });
});

suite("buildPagingInfo", function () {
  test("offers a pager for a pageable statement with more rows behind it", function () {
    const info = buildPagingInfo("SELECT * FROM BIGT", FB6, PAGE, true);
    assert.ok(info);
    assert.strictEqual(info!.sql, "SELECT * FROM BIGT");
    assert.strictEqual(info!.pageSize, PAGE);
    assert.strictEqual(info!.offset, 0, "the rows on screen are always the first page");
    assert.strictEqual(info!.hasMore, true);
    assert.strictEqual(info!.ordered, false);
  });

  test("reports a top-level ORDER BY, which decides whether the grid warns", function () {
    assert.strictEqual(buildPagingInfo("SELECT * FROM T ORDER BY ID", FB6, PAGE, true)!.ordered, true);
  });

  test("no pager when the whole result is already on screen", function () {
    // Offering to fetch a next page that is known to be empty is noise, not a feature.
    assert.strictEqual(buildPagingInfo("SELECT * FROM T", FB6, PAGE, false), undefined);
  });

  test("no pager when the statement cannot be paged", function () {
    assert.strictEqual(buildPagingInfo("SELECT FIRST 10 * FROM T", FB6, PAGE, true), undefined);
    assert.strictEqual(buildPagingInfo("UPDATE T SET X = 1", FB6, PAGE, true), undefined);
  });

  test("no pager on a server without OFFSET/FETCH", function () {
    assert.strictEqual(buildPagingInfo("SELECT * FROM T", 2, PAGE, true), undefined);
  });

  test("no pager when the SQL behind the result is unknown", function () {
    // Several paths open this view with rows but no statement — Show Table Info, Object Search.
    // There is nothing to re-issue, so those keep the plain capped view.
    assert.strictEqual(buildPagingInfo(undefined, FB6, PAGE, true), undefined);
  });

  test("no pager when the page size is not a usable number", function () {
    // maxResultRows = 0 means "no limit", so nothing was trimmed and there is no page to fetch.
    assert.strictEqual(buildPagingInfo("SELECT * FROM T", FB6, 0, true), undefined);
    assert.strictEqual(buildPagingInfo("SELECT * FROM T", FB6, NaN, true), undefined);
  });
});

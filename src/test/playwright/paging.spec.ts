/**
 * Server-side paging in the results grid — docs/roadmap/large-result-sets.md, phase 2.
 *
 * This is the only tier that can check the feature at all. The unit tier covers which statements
 * can be paged and what the labels say, but "Next" is a round trip: the webview posts `fetchPage`,
 * the extension host re-issues the statement with an OFFSET/FETCH window, and the grid swaps its
 * rows in place. A mismatch anywhere along that chain — a message name, a payload shape, a
 * DataTables API call — passes every other tier and fails for every user.
 *
 * Needs a table with more rows than the page size. Rather than depend on a seeded one, the spec
 * sets `firebird.maxResultRows` to 5 in the workspace, so any table with six rows is "large".
 */

import { test, expect, makeWorkspace, launchVSCode, addConnection, runQueryInEditor, webviewFrame, type LaunchedVSCode } from "./vscode-fixture";

/** Small enough that any test database can overflow it, so the spec needs no seeded data. */
const PAGE_SIZE = 5;

/**
 * Generated in the query itself rather than read from a table, so this spec depends on no schema
 * at all: a recursive CTE over RDB$DATABASE yielding 1..20. It is still a plain top-level SELECT,
 * which is exactly what the pager accepts.
 */
const QUERY = "WITH RECURSIVE N (ID) AS (SELECT 1 FROM RDB$DATABASE UNION ALL SELECT ID + 1 FROM N WHERE ID < 20) SELECT ID FROM N ORDER BY ID;";

test.describe("Results grid – server-side paging", () => {
  test.skip(
    !process.env.FIREBIRD_DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    vscode = await launchVSCode(
      makeWorkspace({
        files: {
          "activate.sql": `${QUERY}\n`,
          ".vscode/settings.json": JSON.stringify({ "firebird.maxResultRows": PAGE_SIZE }, null, 2),
        },
      })
    );
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("a capped result offers a pager, and Next fetches the next window from the server", async () => {
    const { page } = vscode;

    await addConnection(page);
    await runQueryInEditor(page);

    await page.locator("iframe.webview").first().waitFor({ state: "attached", timeout: 60_000 });
    const frame = webviewFrame(page);

    // Cell-level rather than text-containment assertions: the grid's first page holds "1" and its
    // second holds "10", so `toContainText("1")` cannot tell the two pages apart.
    // The leading column is the row-delete button, so the value is the second cell.
    const idCells = frame.locator("table.dataTable tbody tr td:nth-child(2)");

    // First page: rows 1–5, and the grid says there are more without claiming a total.
    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–5 of more", { timeout: 60_000 });
    await expect(idCells).toHaveText(["1", "2", "3", "4", "5"]);
    // Previous is disabled on the first page — there is nothing before row 1.
    await expect(frame.locator(".btn-page-prev")).toBeDisabled();

    // Next is a genuine round trip to the server, not a slice of rows already in the webview.
    await frame.locator(".btn-page-next").click();
    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 6–10 of more");
    await expect(idCells).toHaveText(["6", "7", "8", "9", "10"]);
    await expect(frame.locator(".btn-page-prev")).toBeEnabled();

    // And back again, which proves the offset arithmetic works in both directions.
    await frame.locator(".btn-page-prev").click();
    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–5 of more");
    await expect(idCells).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(frame.locator(".btn-page-prev")).toBeDisabled();
  });

  test("filtering re-queries the whole table, not the page on screen", async () => {
    // The point of push-down: BIGT's row 24999 is nowhere near the first page, so a client-side
    // filter over the five rows in the grid could never find it. Only a re-issued query can.
    const { page } = vscode;
    const frame = webviewFrame(page);

    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SELECT * FROM BIGT");
    await runQueryInEditor(page);

    // A whole-table SELECT, so the filter controls appear.
    await expect(frame.locator(".fb-filter-row")).toBeVisible({ timeout: 60_000 });

    await frame.locator(".fb-filter-column").selectOption("NOTE");
    await frame.locator(".fb-filter-operator").selectOption("equals");
    await frame.locator(".fb-filter-value").fill("row 24999");
    await frame.locator(".btn-filter-apply").click();

    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–1 of 1", { timeout: 60_000 });
    await expect(frame.locator("table.dataTable tbody tr td:nth-child(2)")).toHaveText(["24999"]);
  });

  test("sorting a column header re-queries, so it sorts the whole table", async () => {
    // BIGT's largest id is 25000, which is not on the first page — a client-side sort of the five
    // rows in the grid could only ever surface 5. Reaching 25000 proves the server re-sorted.
    const { page } = vscode;
    const frame = webviewFrame(page);

    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SELECT * FROM BIGT");
    await runQueryInEditor(page);
    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–5 of more", { timeout: 60_000 });

    // DataTables sorts ascending on the first click and descending on the second.
    const idHeader = frame.locator("th", { hasText: "ID" }).first();
    await idHeader.click();
    await expect(frame.locator("table.dataTable tbody tr td:nth-child(2)")).toHaveText(["1", "2", "3", "4", "5"]);
    await idHeader.click();
    await expect(frame.locator("table.dataTable tbody tr td:nth-child(2)")).toHaveText(["25000", "24999", "24998", "24997", "24996"]);
  });

  test("a query that is not a whole table gets paging but no filter controls", async () => {
    // Rewriting `SELECT ID FROM BIGT WHERE ID > 100` as `SELECT * FROM BIGT WHERE …` would drop
    // the user's own predicate and change the columns, so push-down is deliberately not offered.
    const { page } = vscode;
    const frame = webviewFrame(page);

    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SELECT ID FROM BIGT WHERE ID > 100");
    await runQueryInEditor(page);

    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–5 of more", { timeout: 60_000 });
    await expect(frame.locator(".fb-filter-row")).toHaveCount(0);
  });

  test("the order warning appears only when the query has no ORDER BY", async () => {
    // The warning is only correct for a statement whose row order Firebird is free to change.
    // Both halves are asserted here, and the query is re-run rather than inherited from an earlier
    // test: these share one VS Code, so depending on what a previous test left on screen is how a
    // spec passes alone and fails in the suite.
    const { page } = vscode;
    const frame = webviewFrame(page);

    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SELECT ID FROM BIGT");
    await runQueryInEditor(page);
    await expect(frame.locator(".fb-page-warning")).toHaveCount(1, { timeout: 60_000 });

    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SELECT ID FROM BIGT ORDER BY ID");
    await runQueryInEditor(page);
    await expect(frame.locator(".fb-page-label")).toHaveText("Rows 1–5 of more", { timeout: 60_000 });
    await expect(frame.locator(".fb-page-warning")).toHaveCount(0);
  });
});

/**
 * The spec this whole tier exists for: does the results grid **render**?
 *
 * `src/test/result-view-webview.test.ts` covers the grid's pure functions well, but it runs
 * `app.js` under a Proxy-based stub DOM that returns a no-op for anything it does not recognise.
 * A broken selector, a JS error at load, a jQuery/DataTables initialisation failure, or a mismatch
 * between the message the extension host posts and the shape the webview expects would all pass
 * there and fail for every user. This drives the real thing end to end: a real query, against a
 * real Firebird server, rendered in a real webview.
 *
 * Requires a reachable database, configured exactly like the other database-backed tiers
 * (`FIREBIRD_*`, see `src/test/suite/firebird-test-env.ts`). The query reads from `RDB$DATABASE`,
 * so any Firebird database will do — no seeded schema needed.
 */

import { test, expect, makeWorkspace, launchVSCode, addConnection, runQueryInEditor, runCommand, expectWebviewText, webviewFrame, type LaunchedVSCode } from "./vscode-fixture";

/** Unlikely to appear anywhere in the workbench chrome, so finding it proves the grid rendered it. */
const SENTINEL = "8675309";
/**
 * A *user* table: the completion cache this feature resolves against is built from
 * `getTablesQuery()`, which excludes system tables — so `RDB$DATABASE` deliberately does not
 * resolve, and using it here is what made the first version of this spec fail.
 */
const TABLE = "CAP_DEMO";

test.describe("Query results grid", () => {
  test.skip(
    !process.env.FIREBIRD_DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    // The query goes in the file the fixture already opens at startup, so the spec never has to
    // drive the file picker.
    vscode = await launchVSCode(
      makeWorkspace({ files: { "activate.sql": `SELECT ${SENTINEL} AS ANSWER FROM RDB$DATABASE;\n` } })
    );
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("renders a real query's rows in the results webview", async () => {
    const { page } = vscode;

    await addConnection(page);
    await runQueryInEditor(page);

    await expectWebviewText(page, SENTINEL);

    // Assert on a *grid cell*, not just on the webview's text. The sentinel is also in the SQL,
    // which the batch tab label shows verbatim — so the assertion above passes even when the grid
    // renders nothing at all, and it did: from 015d75e until this was added, the batch view built
    // its DataTable against a detached panel and every Run Query produced an empty grid.
    await page.locator("iframe.webview").first().waitFor({ state: "attached", timeout: 60_000 });
    await expect(webviewFrame(page).locator("table.dataTable tbody td", { hasText: SENTINEL }).first())
      .toBeVisible({ timeout: 60_000 });
  });

  test("the results tab carries its themed icon", async () => {
    // docs/roadmap/vscode-api-adoption.md: the five webview panels all used to show the generic
    // editor icon, making a tab strip with results + plan + designer open unreadable. A ThemeIcon
    // renders as a codicon in the tab, which is checkable from here and nowhere else — the unit
    // tier's `vscode` mock would happily accept any string.
    const { page } = vscode;
    await expect(page.locator('.tab .codicon-table').first()).toBeVisible({ timeout: 30_000 });
  });

  test("Go to Definition on a table opens its generated DDL", async () => {
    // docs/roadmap/sql-language-features.md phase 3. Worth checking here because the whole point
    // is a *generated* document behind a custom URI scheme — the unit tier covers the URI and the
    // name lookup, but not that the definition provider and the content provider are wired
    // together such that VS Code actually opens something.
    const { page } = vscode;
    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`SELECT * FROM ${TABLE}`);
    await page.keyboard.press("End");
    await runCommand(page, "Go to Definition");

    // Assert on the tab, not on `.monaco-editor` first(): the query file is still open and is
    // still the first editor in the DOM, so matching the first one checks the wrong document —
    // which is exactly how the first version of this failed, in 435ms rather than on a timeout.
    await expect(page.locator(".tab", { hasText: `${TABLE}.sql` })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".monaco-editor", { hasText: "CREATE TABLE" }).first()).toBeVisible();
  });
});

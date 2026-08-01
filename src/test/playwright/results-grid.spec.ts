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

import { test, expect, makeWorkspace, launchVSCode, addConnection, runQueryInEditor, expectWebviewText, type LaunchedVSCode } from "./vscode-fixture";

/** Unlikely to appear anywhere in the workbench chrome, so finding it proves the grid rendered it. */
const SENTINEL = "8675309";

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
  });

  test("the results tab carries its themed icon", async () => {
    // docs/roadmap/vscode-api-adoption.md: the five webview panels all used to show the generic
    // editor icon, making a tab strip with results + plan + designer open unreadable. A ThemeIcon
    // renders as a codicon in the tab, which is checkable from here and nowhere else — the unit
    // tier's `vscode` mock would happily accept any string.
    const { page } = vscode;
    await expect(page.locator('.tab .codicon-table').first()).toBeVisible({ timeout: 30_000 });
  });
});

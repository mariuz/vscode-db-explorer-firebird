/**
 * The query plan view's diagram.
 *
 * `src/test/query-plan-view-webview.test.ts` covers `layoutForest()` and the other pure layout
 * functions under the stub DOM, but the SVG those coordinates become has never been drawn by a
 * test. This runs the real command against a real server.
 *
 * This spec is also what found the bug it now guards: showing the webview takes focus, so the
 * plan fetch — which happens when the webview reports "ready" — used to resolve
 * `window.activeTextEditor` as undefined and render "No SQL document opened!". The command now
 * captures the SQL before opening the view.
 */

import { test, makeWorkspace, launchVSCode, addConnection, runCommand, expectWebviewText, type LaunchedVSCode } from "./vscode-fixture";

const TABLE = "CAP_DEMO";

test.describe("Query plan view", () => {
  test.skip(
    !process.env.FIREBIRD_DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    vscode = await launchVSCode(makeWorkspace({ files: { "activate.sql": `SELECT * FROM ${TABLE};\n` } }));
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("renders a plan for the query in the editor", async () => {
    const { page } = vscode;

    await addConnection(page);
    await page.locator(".monaco-editor").first().click();
    await runCommand(page, "Firebird: Show Graphical Query Plan");

    // A real `PLAN (...)` string — and therefore a diagram — needs the native driver, which is not
    // what a default install uses. On the pure-JS driver the view is expected to say so *clearly*,
    // and that message is what this asserts: it is the branch a default install actually hits.
    //
    // This spec found two bugs. The plan used to fetch after the webview had taken focus, so
    // `window.activeTextEditor` was already gone and it rendered "No SQL document opened!"; and
    // the fallback-text detection missed one of `renderIndexMetadataPlan()`'s three shapes, so a
    // table without indexes produced `Couldn't parse the plan: Expected "PLAN" but found "--"`
    // instead of this message.
    await expectWebviewText(page, "native driver", 90_000);
  });
});

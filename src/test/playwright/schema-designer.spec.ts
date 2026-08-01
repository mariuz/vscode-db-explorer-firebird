/**
 * The Schema Designer's diagram, reached from the Command Palette.
 *
 * This spec was impossible until `firebird.schemaVisualizer.open` learned to fall back to the
 * connection picker: the command takes a `NodeDatabase`, so it could only be invoked from the
 * tree's context menu, which an automated test cannot drive reliably (an earlier attempt right-
 * clicked a `.monaco-list-row` and got VS Code's generic "Copy Text" menu instead).
 *
 * It is also the first check that the designer webview *renders* — `src/test/webview-harness.ts`
 * names `render()`/`measureAll()` as out of its scope precisely because they need real text
 * measurement and SVG geometry.
 */

import { test, expect, makeWorkspace, launchVSCode, addConnection, runCommand, expectWebviewText, type LaunchedVSCode } from "./vscode-fixture";

test.describe("Schema Designer", () => {
  test.skip(
    !process.env.FIREBIRD_DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    vscode = await launchVSCode(makeWorkspace());
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("renders the connected database's tables as a diagram", async () => {
    const { page } = vscode;

    await addConnection(page);
    await runCommand(page, "Firebird: Visualize Schema");

    // The palette fallback asks which connection; there is exactly one.
    await page.locator(".quick-input-widget .input").waitFor({ state: "visible" });
    await page.locator(".quick-input-list .monaco-list-row").first().waitFor();
    await page.keyboard.press("Enter");

    // A table name inside the webview means the schema was fetched, laid out and drawn.
    await expectWebviewText(page, "CAP_DEMO", 90_000);
  });
});

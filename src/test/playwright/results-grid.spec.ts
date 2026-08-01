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

import { test, expect, makeWorkspace, launchVSCode, runCommand, type LaunchedVSCode } from "./vscode-fixture";

const HOST = process.env.FIREBIRD_HOST ?? "localhost";
const PORT = process.env.FIREBIRD_PORT ?? "3050";
const DATABASE = process.env.FIREBIRD_DATABASE;
const USER = process.env.FIREBIRD_USER ?? "SYSDBA";
const PASSWORD = process.env.FIREBIRD_PASSWORD ?? "masterkey";

/** Unlikely to appear anywhere in the workbench chrome, so finding it proves the grid rendered it. */
const SENTINEL = "8675309";

test.describe("Query results grid", () => {
  test.skip(
    !DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    // The query goes in the file the fixture already opens at startup, so the spec never has to
    // drive the file picker — and the editor is guaranteed to be the active one when the query
    // runs, which `firebird.runQuery` requires (it reads `window.activeTextEditor`).
    vscode = await launchVSCode(
      makeWorkspace({ files: { "activate.sql": `SELECT ${SENTINEL} AS ANSWER FROM RDB$DATABASE;\n` } })
    );
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("renders a real query's rows in the results webview", async () => {
    const { page } = vscode;

    // 1. Add the connection through the wizard's paste-a-connection-string path: one palette
    //    command and one input box, and it stores the password in SecretStorage and sets the
    //    connection active on the way out (`saveNewConnection`). The alternative — a workspace
    //    `.vscode/firebird.json` — cannot carry a password by design, and the only way to supply
    //    one for it is the tree's context menu, since `firebird.database.setPassword` takes a
    //    NodeDatabase argument and is not reachable from the palette.
    await runCommand(page, "Firebird: Add New Connection");

    // Wait for the wizard's *own* prompt, not merely for a visible input: the Command Palette and
    // the wizard share the `.quick-input-widget .input` selector, so filling as soon as an input
    // exists can type the connection string into the palette that is still closing — which is
    // exactly what happened the first time, leaving the palette showing "No matching commands"
    // and Enter doing nothing at all.
    await expect(
      page.locator(".quick-input-widget", { hasText: "Paste a Firebird connection string" })
    ).toBeVisible();
    // `?wireCrypt=` only when the environment asks for it, matching the e2e tier's own
    // FIREBIRD_WIRE_CRYPT convention — a stock Firebird 4+ install defaults to WireCrypt=Enabled.
    const wireCrypt = process.env.FIREBIRD_WIRE_CRYPT ? `?wireCrypt=${process.env.FIREBIRD_WIRE_CRYPT}` : "";
    await page
      .locator(".quick-input-widget .input")
      .fill(`firebird://${USER}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}${wireCrypt}`);
    await page.keyboard.press("Enter");

    // 2. The status bar stops saying "No active database" once the connection is saved and made
    //    active — a deterministic signal that step 1 got all the way through, rather than a sleep.
    await expect(page.locator(".statusbar-item", { hasText: "FIREBIRD:" }).first()).not.toContainText(
      "No active database",
      { timeout: 60_000 }
    );

    // 3. Focus the editor: the wizard left focus in the quick input, and `runQuery` reads
    //    `window.activeTextEditor`, which is undefined if the editor is not the active part.
    await page.locator(".monaco-editor").first().click();
    await runCommand(page, "Firebird: Run Firebird Query");

    // 4. The payoff. VS Code nests webview content two iframes deep: the outer `iframe.webview`
    //    belongs to the workbench, the inner `#active-frame` is the extension's own document.
    const webview = page.frameLocator("iframe.webview").frameLocator("#active-frame");
    await expect(webview.locator("body")).toContainText(SENTINEL, { timeout: 60_000 });
  });
});

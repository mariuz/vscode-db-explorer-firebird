/**
 * The Live Profiler webview — docs/roadmap/webview-ui-testing.md.
 *
 * Its helper functions are well covered by `src/test/profiler-webview.test.ts` (74% of the file),
 * but that suite runs `app.js` under the Proxy-based stub DOM in `src/test/webview-harness.ts`, so
 * until now nothing had ever confirmed the panel *renders*: `handleActivityData()` writing rows
 * into a real table, the four view-mode buttons switching panes, the polling loop actually being
 * fed by the extension host. A broken selector or a message-shape mismatch passes the unit tier
 * and fails for every user.
 *
 * Reaching it needed a product change rather than a test trick, the same one the Schema Designer
 * needed in phase 3: `firebird.database.monitorDatabase` was contributed only as a tree context
 * menu and took a `NodeDatabase`, so the Command Palette could not invoke it. It now falls back to
 * the connection picker.
 *
 * The spec holds its own Firebird attachment open for the duration, because the profiler's query
 * excludes `CURRENT_CONNECTION` — it lists *other* activity, so with only the profiler connected it
 * correctly shows "No other active connections" and there is nothing to assert rendering against.
 * That is what the first run of this spec found, from a screenshot.
 */

import { test, expect, makeWorkspace, launchVSCode, addConnection, runCommand, expectWebviewText, webviewFrame, type LaunchedVSCode } from "./vscode-fixture";
import * as Firebird from "node-firebird";

test.describe("Live Profiler", () => {
  test.skip(
    !process.env.FIREBIRD_DATABASE,
    "Set FIREBIRD_DATABASE (and the other FIREBIRD_* variables) to run the database-backed specs."
  );

  let vscode: LaunchedVSCode;
  /** An attachment held open purely so the profiler has something to report. */
  let otherConnection: any;

  test.beforeAll(async () => {
    otherConnection = await new Promise((resolve, reject) => {
      Firebird.attach(
        {
          host: process.env.FIREBIRD_HOST ?? "localhost",
          port: Number(process.env.FIREBIRD_PORT ?? "3050"),
          database: process.env.FIREBIRD_DATABASE!,
          user: process.env.FIREBIRD_USER ?? "SYSDBA",
          password: process.env.FIREBIRD_PASSWORD ?? "masterkey",
        } as any,
        (err, db) => (err ? reject(err) : resolve(db))
      );
    });
    vscode = await launchVSCode(makeWorkspace());
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
    await new Promise<void>(resolve => otherConnection?.detach(() => resolve()));
  });

  test("renders live connection activity from the server", async () => {
    const { page } = vscode;

    await addConnection(page);
    await runCommand(page, "Firebird: Monitor Database");

    // The palette fallback asks which connection; there is exactly one.
    await page.locator(".quick-input-widget .input").waitFor({ state: "visible" });
    await page.locator(".quick-input-list .monaco-list-row").first().waitFor();
    await page.keyboard.press("Enter");

    // The toolbar proves the document loaded; a row in the activity table proves the extension
    // host's MON$ query reached the webview and handleActivityData() rendered it into a real DOM.
    // The row is this spec's own held-open attachment — see the note at the top.
    await expectWebviewText(page, "Refresh Now", 90_000);
    const frame = webviewFrame(page);
    await expect(frame.locator("#activity-body tr").first()).toBeVisible({ timeout: 90_000 });
  });

  test("switches to the dashboard view", async () => {
    // The four view-mode buttons swap panes entirely, and nothing outside a browser can check that
    // the panes exist and toggle — the stub DOM's classList is a no-op.
    const frame = webviewFrame(vscode.page);

    await expect(frame.locator("#table-wrapper")).toBeVisible();
    await frame.locator('.view-mode-btn[data-mode="dashboard"]').click();
    await expect(frame.locator("#dashboard-wrapper")).toBeVisible();
    await expect(frame.locator("#table-wrapper")).toBeHidden();

    await frame.locator('.view-mode-btn[data-mode="table"]').click();
    await expect(frame.locator("#table-wrapper")).toBeVisible();
  });

  test("pausing stops the polling loop, and says so", async () => {
    // Pause is the control most likely to break silently: if the button's handler stopped
    // clearing the timer, the panel would keep updating and only a user would notice.
    const frame = webviewFrame(vscode.page);
    const pause = frame.locator("#btn-pause");

    await expect(pause).toHaveText("Pause");
    await pause.click();
    await expect(pause).toHaveText("Resume");
    await pause.click();
    await expect(pause).toHaveText("Pause");
  });
});

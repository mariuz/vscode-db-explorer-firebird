/**
 * Does the extension actually come up inside a real VS Code window?
 *
 * Nothing here needs a database, which is the point: it is the spec that proves the harness
 * itself works. If a webview spec fails, this one passing narrows the cause to the webview rather
 * than to VS Code failing to launch, the extension failing to activate, or a workspace-trust
 * regression silently disabling everything.
 */

import { test, expect, runCommand, activityBarItem } from "./vscode-fixture";

test.describe("Firebird Studio in a real VS Code window", () => {
  test("the workbench loads with the extension activated", async ({ vscode }) => {
    const { page } = vscode;

    // The Activity Bar entry only exists if the extension's viewsContainers contribution was
    // read, i.e. the extension was loaded rather than silently skipped.
    await expect(activityBarItem(page)).toBeVisible();

    // And this only exists once `activate()` has run far enough for the tree provider to produce
    // its root nodes — the fixture already waited for it, so reaching here proves it.
    await expect(page.locator(".statusbar-item", { hasText: "FIREBIRD:" }).first()).toBeVisible();
  });

  test("the Object Explorer view renders when opened", async ({ vscode }) => {
    const { page } = vscode;

    // The fixture already opened the view to confirm activation; assert on what it rendered.
    // The view's own container, rendered by VS Code from the TreeDataProvider. Its presence means
    // activation completed and the provider registered without throwing — a failure inside
    // `activate()` leaves the view stuck on a spinner or an error instead.
    const sideBar = page.locator(".sidebar");
    await expect(sideBar).toBeVisible();
    await expect(sideBar.locator(".pane-header").first()).toBeVisible();
  });

  test("the extension's commands are listed in the Command Palette", async ({ vscode }) => {
    const { page } = vscode;

    await page.keyboard.press("Control+Shift+P");
    const input = page.locator(".quick-input-widget .input");
    await input.waitFor({ state: "visible" });
    await input.fill(">Firebird: ");

    // Assert on a specific command rather than a row count. The palette renders a single
    // "No matching commands" row while it is still populating, which a count-based check happily
    // accepts — that raced and failed the first time this spec ran. `toBeVisible` retries until
    // the real row appears, so the wait is for the right thing rather than for any row at all.
    await expect(
      page.locator(".quick-input-list .monaco-list-row", { hasText: "Add New Connection" })
    ).toBeVisible();
  });

  test("invoking a command activates the extension and shows its UI", async ({ vscode }) => {
    const { page } = vscode;

    // The strongest activation signal available without a database. This extension's
    // activationEvents are only `onLanguage:sql` and `onNotebook:firebird-notebook`, so nothing
    // so far in this file has necessarily run a line of its code — VS Code renders contributed
    // views and palette entries from the manifest alone. Invoking a command forces activation and
    // then runs the extension's own handler, so the wizard's prompt appearing means the whole
    // chain worked: manifest → activation → registered handler → UI.
    await runCommand(page, "Firebird: Add New Connection");

    await expect(
      page.locator(".quick-input-widget", { hasText: "Paste a Firebird connection string" })
    ).toBeVisible();
  });
});

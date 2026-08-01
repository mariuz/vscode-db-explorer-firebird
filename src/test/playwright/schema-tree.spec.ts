/**
 * The Firebird 6 schema level in the Object Explorer.
 *
 * Checkable only here: whether the extra level appears, and what sits under it, is a property of
 * the rendered tree rather than of any function — the unit tier can assert what `getChildren()`
 * returns but not that VS Code shows it.
 */

import { test, expect, makeWorkspace, launchVSCode, addConnection, type LaunchedVSCode } from "./vscode-fixture";

test.describe("Schemas in the Object Explorer", () => {
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

  test("a two-schema database shows a schema level", async () => {
    const { page } = vscode;
    // The fixture already opened the Firebird view to confirm activation; clicking the activity
    // bar again would toggle it *closed*, which is how the first version of this spec failed.
    await addConnection(page);

    const sideBar = page.locator(".sidebar");

    /**
     * Expanding a tree row is retried rather than done once.
     *
     * Selecting a row and pressing ArrowRight is the only reliable way to expand it — the twistie
     * has no stable selector — but the keypress lands only if the row already has focus, which it
     * may not immediately after a click while the tree is still rendering. Passing standalone and
     * failing inside the full suite is what that looks like.
     */
    const expand = async (row: ReturnType<typeof sideBar.locator>, revealed: string) => {
      await expect(async () => {
        await row.waitFor({ state: "visible", timeout: 5_000 });
        await row.click();
        await page.keyboard.press("ArrowRight");
        await expect(sideBar.locator(".monaco-list-row", { hasText: revealed }).first())
          .toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
    };

    await expand(sideBar.locator(".monaco-list-row").first(), ".fdb");
    await expand(sideBar.locator(".monaco-list-row", { hasText: ".fdb" }).first(), "SALES");

    // PUBLIC and SALES both exist in the test database, so both should be listed.
    await expect(sideBar.locator(".monaco-list-row", { hasText: "SALES" }).first()).toBeVisible();
    await expect(sideBar.locator(".monaco-list-row", { hasText: "PUBLIC" }).first()).toBeVisible();
  });
});

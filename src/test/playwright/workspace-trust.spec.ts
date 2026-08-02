/**
 * Workspace Trust in Restricted Mode — the `untrustedWorkspaces: "limited"` declaration.
 *
 * This is the only tier that can check it at all. The manifest tests assert what the declaration
 * *says*; whether VS Code then actually loads the extension in Restricted Mode, and whether the
 * folder's own connections are really withheld, is a question about a running workbench.
 *
 * Before this, the extension declared `supported: false` and did not load in an untrusted folder
 * at all — so the interesting assertion here is simply that the view exists.
 */

import { test, expect, makeWorkspace, launchVSCode, activityBarItem, type LaunchedVSCode } from "./vscode-fixture";

/** A connection the *folder* declares — exactly what must not appear until the folder is trusted. */
const WORKSPACE_CONNECTION = JSON.stringify(
  { connections: [{ name: "Untrusted Workspace DB", host: "db.example.com", database: "/srv/app.fdb" }] },
  null,
  2
);

test.describe("Workspace Trust – Restricted Mode", () => {
  let vscode: LaunchedVSCode;

  test.beforeAll(async () => {
    vscode = await launchVSCode(
      makeWorkspace({ files: { ".vscode/firebird.json": WORKSPACE_CONNECTION } }),
      { trust: false }
    );
  });

  test.afterAll(async () => {
    await vscode?.app.close().catch(() => undefined);
  });

  test("the extension still loads in an untrusted folder", async () => {
    // With `supported: false` the Activity Bar entry did not exist at all: VS Code disables the
    // whole extension, contributions included. Its presence is the feature.
    const { page } = vscode;
    await expect(activityBarItem(page)).toBeVisible({ timeout: 120_000 });
    await activityBarItem(page).click();
    await expect(page.locator(".pane-header", { hasText: "DB Explorer" }).first()).toBeVisible({ timeout: 60_000 });
  });

  test("the workbench really is in Restricted Mode", async () => {
    // Otherwise the test above would pass for the boring reason that trust was granted anyway, and
    // the assertion below would prove nothing.
    await expect(vscode.page.locator(".statusbar-item", { hasText: /Restricted Mode/i }).first())
      .toBeVisible({ timeout: 60_000 });
  });

  test("the folder's own connections are withheld", async () => {
    // .vscode/firebird.json cannot carry a password, so a malicious repository's entry would
    // instead prompt for one — a plausible-looking connection pointing at a server the attacker
    // chose. This is the reason support is "limited" rather than full.
    // The view is already open from the first test — these share one workbench, and clicking the
    // Activity Bar item again *toggles it closed*.
    const { page } = vscode;
    await expect(page.locator(".pane-header", { hasText: "DB Explorer" }).first()).toBeVisible();
    await expect(page.locator(".sidebar").getByText("Untrusted Workspace DB")).toHaveCount(0);
  });
});

/**
 * Assertions about package.json itself — the manifest is as much a part of the extension's
 * behaviour as its code, but nothing else in the unit tier checks it. These guard declarations
 * whose *absence* is silent: VS Code does not warn when a capability is missing, it just picks
 * a default, so a deleted or mistyped key would otherwise only surface as a user-visible
 * behaviour change nobody intended.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// out/test/manifest.test.js -> ../../ is the repository root.
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
);

suite("package.json – Workspace Trust", function () {
  test("declares untrustedWorkspaces support explicitly", function () {
    const untrusted = packageJson?.capabilities?.untrustedWorkspaces;
    assert.ok(
      untrusted,
      "capabilities.untrustedWorkspaces must be declared. Omitting it means VS Code silently " +
        "disables the extension in Restricted Mode with no explanation shown to the user — the " +
        "same behaviour as `supported: false`, but without the reason."
    );
  });

  test("does not claim to support untrusted workspaces", function () {
    // Deliberately `false`, not `true` or "limited": firebird.isqlPath / firebird.gbakPath /
    // firebird.dockerPath are window-scoped, so a checked-out repository can point them at any
    // executable, and .vscode/firebird.json supplies connection targets. Supporting "limited"
    // would first require those settings to be machine-scoped — see
    // docs/roadmap/test-coverage-and-reporting.md, phase 5.
    assert.strictEqual(
      packageJson.capabilities.untrustedWorkspaces.supported,
      false,
      "Untrusted-workspace support must not be widened without also restricting the " +
        "executable-path settings that make it unsafe."
    );
  });

  test("explains why trust is required", function () {
    const description = packageJson.capabilities.untrustedWorkspaces.description;
    assert.strictEqual(
      typeof description,
      "string",
      "A `supported: false` declaration requires a description; it is what the user is shown " +
        "in place of the extension."
    );
    assert.ok(description.length > 0, "The description must not be empty");
  });

  test("the settings named in the description still exist", function () {
    // The description justifies the restriction by naming specific settings. If one is renamed
    // or removed, the justification silently becomes wrong — this keeps the two in step.
    const properties = packageJson?.contributes?.configuration?.properties ?? {};
    for (const setting of ["firebird.isqlPath", "firebird.gbakPath", "firebird.dockerPath"]) {
      assert.ok(
        setting in properties,
        `The Workspace Trust description names ${setting}, which no longer exists`
      );
    }
  });
});

suite('package.json – per-node tree refresh', function () {
  test('Refresh is offered on individual tree nodes, not only in the view title', function () {
    // `firebird.explorer.refresh` has always accepted a node argument and passed it to
    // `refresh(node)` — but nothing ever supplied one, because the command was contributed only to
    // view/title, which invokes it with undefined. The plumbing existed and was unused.
    const items = packageJson?.contributes?.menus?.["view/item/context"] ?? [];
    const entry = items.find((e: any) => e.command === "firebird.explorer.refresh");
    assert.ok(entry, "Refresh should appear in the tree item context menu");
    for (const context of ["viewItem == host", "viewItem == database", "folder"]) {
      assert.ok(
        String(entry.when).includes(context),
        `Refresh should be offered on ${context}; when clause was: ${entry.when}`
      );
    }
  });

  test('the view-title Refresh is still there — the two are different operations', function () {
    // Refreshing one node re-reads only that subtree; the title button re-reads every expanded
    // node across every connection. Losing either would be a regression.
    const titleItems = packageJson?.contributes?.menus?.["view/title"] ?? [];
    assert.ok(titleItems.some((e: any) => e.command === "firebird.explorer.refresh"));
  });
});

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

  test("supports untrusted workspaces in limited mode", function () {
    // "limited", not `true`: the extension is useful in an untrusted folder — your own saved
    // connections are yours, not the folder's — but two things the folder controls are withheld.
    // See the two tests below for what each of them is.
    assert.strictEqual(packageJson.capabilities.untrustedWorkspaces.supported, "limited");
  });

  test("the executable-path settings cannot be set by an untrusted folder", function () {
    // A repository's own .vscode/settings.json can set any window-scoped setting, so without this
    // list, opening an untrusted folder could point isql/gbak/docker at any binary on disk and the
    // next backup would run it. `restrictedConfigurations` makes VS Code ignore the *workspace*
    // value while untrusted — which is why these stay window-scoped rather than becoming machine-
    // scoped: setting a per-project isql is legitimate in a folder you trust.
    const restricted = packageJson.capabilities.untrustedWorkspaces.restrictedConfigurations ?? [];
    for (const setting of ["firebird.isqlPath", "firebird.gbakPath", "firebird.dockerPath"]) {
      assert.ok(
        restricted.includes(setting),
        `${setting} runs an external program and must be restricted in untrusted workspaces; ` +
          `restrictedConfigurations was ${JSON.stringify(restricted)}`
      );
    }
  });

  test("every restricted setting still exists", function () {
    // A renamed setting would leave a restriction pointing at nothing — silently unrestricting the
    // real one, since VS Code does not warn about an unknown id here.
    const properties = packageJson?.contributes?.configuration?.properties ?? {};
    for (const setting of packageJson.capabilities.untrustedWorkspaces.restrictedConfigurations ?? []) {
      assert.ok(setting in properties, `restrictedConfigurations names ${setting}, which no longer exists`);
    }
  });

  test("explains what is withheld", function () {
    // This text is what the user is shown when deciding whether to trust the folder, so it has to
    // say what they lose by not doing so rather than merely that something is restricted.
    const description = packageJson.capabilities.untrustedWorkspaces.description;
    assert.strictEqual(typeof description, "string");
    assert.ok(description.length > 0, "The description must not be empty");
    assert.ok(/firebird\.json/.test(description), "it should name the file whose connections are withheld");
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

suite('package.json – schema-level privileges', function () {
  test('Show Object Privileges is offered on a schema node', function () {
    // NodeSchema implements showPrivileges(), but the generic `firebird.showPrivileges` command is
    // reachable only from a `view/item/context` entry matching the node's contextValue — the method
    // alone is dead code, and nothing else in the test tiers would notice.
    const items = packageJson?.contributes?.menus?.["view/item/context"] ?? [];
    const entry = items.find(
      (e: any) => e.command === "firebird.showPrivileges" && String(e.when).includes("viewItem == schema")
    );
    assert.ok(
      entry,
      "firebird.showPrivileges should be contributed for viewItem == schema; contributed for: " +
        items.filter((e: any) => e.command === "firebird.showPrivileges").map((e: any) => e.when).join(", ")
    );
  });

  test('it sits in the same menu group as the other objects\' privileges', function () {
    const items = packageJson?.contributes?.menus?.["view/item/context"] ?? [];
    const groups = new Set(
      items.filter((e: any) => e.command === "firebird.showPrivileges").map((e: any) => e.group)
    );
    assert.strictEqual(
      groups.size,
      1,
      `Show Object Privileges should appear in one group for every node type, found: ${[...groups].join(", ")}`
    );
  });
});

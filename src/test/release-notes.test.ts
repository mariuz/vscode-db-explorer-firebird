/**
 * Release-notes extraction — `scripts/release-notes.mjs`, used by `.github/workflows/release.yml`.
 *
 * The release workflow runs this *before* publishing, so what it returns is what ends up on the
 * GitHub Release, and what it refuses to return stops the release. Both halves are worth pinning:
 * the notes are read at exactly one moment, and nobody re-reads them afterwards.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

// out/test/… -> repository root
const repoRoot = path.join(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "release-notes.mjs");

/** A real dynamic `import()`, hidden from TypeScript — see webview-coverage-scripts.test.ts. */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;

async function extract(changelog: string, version: string): Promise<string | undefined> {
  const { extractReleaseNotes } = await dynamicImport(pathToFileURL(scriptPath).href);
  return extractReleaseNotes(changelog, version);
}

const CHANGELOG = [
  "# Change Log",
  "",
  "## Unreleased",
  "",
  "### Added",
  "",
  "- Something not yet released.",
  "",
  "## 0.2.2 - 2026-07-31",
  "",
  "### Fixed",
  "",
  "- A real fix.",
  "- Another one.",
  "",
  "## 0.2.1 - 2026-07-20",
  "",
  "- An older entry.",
  "",
].join("\n");

suite("release-notes", function () {
  test("returns just that version's section", async function () {
    const notes = await extract(CHANGELOG, "0.2.2");
    assert.ok(notes!.includes("A real fix."));
    assert.ok(notes!.includes("Another one."));
    assert.ok(!notes!.includes("An older entry."), "it must stop at the next version heading");
    assert.ok(!notes!.includes("Something not yet released."), "it must not bleed in from Unreleased");
  });

  test("drops the heading itself, which the release page renders separately", async function () {
    const notes = await extract(CHANGELOG, "0.2.2");
    assert.ok(!notes!.startsWith("## "), notes);
  });

  test("returns undefined for a version with no section", async function () {
    // This is what fails the release: a tag pushed while the work is still filed under
    // "Unreleased" would otherwise publish with empty notes.
    assert.strictEqual(await extract(CHANGELOG, "0.3.0"), undefined);
  });

  test("a version with an empty section counts as missing", async function () {
    const empty = "# Change Log\n\n## 0.3.0 - 2026-08-02\n\n## 0.2.2 - 2026-07-31\n\n- Real.\n";
    assert.strictEqual(await extract(empty, "0.3.0"), undefined);
  });

  test("tolerates the heading styles this changelog has actually used", async function () {
    // The format has drifted; a release should not fail over a dash or a bracket.
    for (const heading of ["## 0.3.0 - 2026-08-02", "## [0.3.0]", "## 0.3.0", "## v0.3.0"]) {
      const changelog = `# Change Log\n\n${heading}\n\n- Note.\n\n## 0.2.2\n\n- Old.\n`;
      assert.strictEqual((await extract(changelog, "0.3.0"))?.trim(), "- Note.", heading);
    }
  });

  test("the version number is matched literally, not as a pattern", async function () {
    // The dots are regex metacharacters; unescaped, "0.2.2" would also match "0X2X2" — and, more
    // realistically, "0.2.2" would match a heading for a different version that happened to differ
    // only in punctuation.
    const changelog = "# Change Log\n\n## 0X2X2\n\n- Wrong section.\n";
    assert.strictEqual(await extract(changelog, "0.2.2"), undefined);
  });

  test("the repository's own changelog has notes for the current version", async function () {
    // The release workflow would fail on this exact condition, and finding out at tag time is
    // worse than finding out on every push.
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
    const notes = await extract(changelog, packageJson.version);
    assert.ok(
      notes,
      `CHANGELOG.md has no section for the current version (${packageJson.version}). ` +
        "Releasing it would produce a GitHub Release with empty notes."
    );
  });
});

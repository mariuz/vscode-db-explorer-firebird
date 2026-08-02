/**
 * Extracts one version's section from CHANGELOG.md, for a GitHub Release body.
 *
 *   node scripts/release-notes.mjs 0.2.3
 *
 * Exits non-zero when there is no section for that version. That is deliberate: the release
 * workflow runs this *before* publishing, so a tag pushed while the changelog still calls the
 * work "Unreleased" fails the run rather than producing a release whose notes are empty — which
 * is the one moment anybody actually reads them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The body of the `## <version>` section, without its heading.
 *
 * Tolerates the shapes this file actually uses — `## 0.2.2 - 2026-07-31`, `## [0.2.2]`, a bare
 * `## 0.2.2` — because the heading format has drifted before and a release should not fail over a
 * dash. Returns undefined when the version has no section at all.
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const escaped = version.replace(/\./g, "\\.");
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const anyHeading = /^##\s/;

  const start = lines.findIndex(line => heading.test(line));
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => anyHeading.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/release-notes.mjs <version>");
    process.exit(2);
  }
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const notes = extractReleaseNotes(changelog, version);
  if (!notes) {
    console.error(
      `CHANGELOG.md has no notes for ${version}. Move the "Unreleased" entries under a ` +
        `"## ${version} - <date>" heading before tagging.`
    );
    process.exit(1);
  }
  process.stdout.write(notes + "\n");
}

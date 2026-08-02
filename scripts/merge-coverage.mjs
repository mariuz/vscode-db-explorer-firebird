/**
 * Merges the unit tier's coverage with the webviews' — docs/roadmap/webview-ui-testing.md, phase 4.
 *
 * The two halves are produced in completely different ways: the unit tier's comes from V8's own
 * counters via c8, the webviews' from istanbul counters that the instrumented code increments
 * itself (see scripts/instrument-webviews.mjs for why V8 cannot reach inside a webview iframe).
 * Both end up in istanbul's on-disk format, though, so merging them is a union — and the two file
 * sets are disjoint, `src/**\/*.ts` against `src/**\/htmlContent/js/*.js`, so nothing overlaps.
 *
 * Deliberately does not enforce thresholds. The unit tier's gate (`c8 report --check-coverage`)
 * still runs and still fails the build; this report exists to *show* how much of the webview code
 * any test has ever executed, and gating on a number nobody has aimed at yet would only invite
 * lowering the number until it passes.
 */

import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { webviewScripts } from "./instrument-webviews.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unitFinal = path.join(repoRoot, "coverage", "unit", "coverage-final.json");
const webviewDir = path.join(repoRoot, "coverage", ".tmp-webview");
const outputDir = path.join(repoRoot, "coverage", "combined");

const map = libCoverage.createCoverageMap({});
let sources = 0;

if (fs.existsSync(unitFinal)) {
  map.merge(JSON.parse(fs.readFileSync(unitFinal, "utf8")));
  sources++;
} else {
  console.warn(`No unit coverage at ${path.relative(repoRoot, unitFinal)} — run \`npm run test\` first.`);
}

if (fs.existsSync(webviewDir)) {
  for (const file of fs.readdirSync(webviewDir)) {
    if (!file.endsWith(".json")) { continue; }
    map.merge(JSON.parse(fs.readFileSync(path.join(webviewDir, file), "utf8")));
    sources++;
  }
} else {
  console.warn("No webview coverage — run `npm run test:playwright:coverage` to produce it.");
}

if (sources === 0) {
  console.error("Nothing to merge.");
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
const context = libReport.createContext({ dir: outputDir, coverageMap: map });
for (const name of ["text-summary", "lcov"]) {
  reports.create(name, {}).execute(context);
}

// A per-webview line so the summary answers the question this phase exists to ask — which webviews
// has any test ever executed — rather than burying it in a whole-repo percentage.
//
// Enumerated from the instrumented file list rather than from the coverage map, so a webview that
// no test ever opened is reported as 0% instead of vanishing from the report. That absence is the
// most useful thing here: a file nothing has run reads as "not listed", which looks like "not
// applicable" rather than "not covered".
const covered = new Map(map.files().filter(f => f.includes("htmlContent")).map(f => [path.resolve(f), f]));
const allWebviews = webviewScripts().map(f => path.resolve(f));
if (allWebviews.length > 0) {
  console.log("\nWebview scripts:");
  for (const file of allWebviews.sort()) {
    const key = covered.get(file);
    const pct = key ? map.fileCoverageFor(key).toSummary().statements.pct : 0;
    const label = key ? "" : "   (never executed by any test)";
    console.log(`  ${pct.toFixed(1).padStart(5)}%  ${path.relative(repoRoot, file)}${label}`);
  }
}
console.log(`\nCombined report written to ${path.relative(repoRoot, outputDir)}`);

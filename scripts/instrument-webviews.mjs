/**
 * Instruments the webviews' JavaScript for coverage, and restores it afterwards —
 * docs/roadmap/webview-ui-testing.md, phase 4.
 *
 * Why instrumentation rather than V8 coverage: c8 reads V8's own counters from the Node process,
 * and a webview runs in an Electron *renderer* iframe that the extension host cannot see. The only
 * way to learn which lines of a webview ran is to have the code count for itself, which is what
 * istanbul's instrumenter does — it rewrites each file to increment counters on a `window.__coverage__`
 * object that the Playwright fixture can then read out of the frame.
 *
 * The files are rewritten **in place**, with the originals saved alongside, because a webview loads
 * its assets by path from `src/…/htmlContent/js/`. Serving an instrumented copy from somewhere else
 * would mean teaching every view a second asset root purely for tests — a change to product code to
 * suit a test, which is the wrong way round. In-place plus a guaranteed restore keeps the change
 * entirely inside this script.
 *
 *   node scripts/instrument-webviews.mjs instrument
 *   node scripts/instrument-webviews.mjs restore
 *
 * `restore` is idempotent and safe to run when nothing was instrumented, so it can go in a
 * `finally`/`always` without a guard.
 */

import { createInstrumenter } from "istanbul-lib-instrument";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Suffix for the saved original. Inside `js/` so a stray one is obvious next to the file it shadows. */
const BACKUP_SUFFIX = ".orig-for-coverage";

/**
 * The webviews' own code. Vendored libraries (jquery, DataTables, pdfmake…) are excluded by the
 * `.min.js` filter: instrumenting them would add tens of thousands of uncovered lines that nobody
 * is going to write tests for, and would drown the numbers that matter.
 */
export function webviewScripts() {
  const found = [];
  const htmlContentDirs = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) { continue; }
      const full = path.join(dir, entry.name);
      if (entry.name === "htmlContent") {
        htmlContentDirs.push(full);
      } else if (entry.name !== "node_modules") {
        walk(full);
      }
    }
  };
  walk(path.join(repoRoot, "src"));

  for (const dir of htmlContentDirs) {
    const jsDir = path.join(dir, "js");
    if (!fs.existsSync(jsDir)) { continue; }
    for (const file of fs.readdirSync(jsDir)) {
      if (file.endsWith(".js") && !file.endsWith(".min.js")) {
        found.push(path.join(jsDir, file));
      }
    }
  }
  return found.sort();
}

function instrument() {
  const instrumenter = createInstrumenter({
    coverageVariable: "__coverage__",
    esModules: false,
    compact: false,
    produceSourceMap: false,
  });

  let count = 0;
  for (const file of webviewScripts()) {
    const backup = file + BACKUP_SUFFIX;
    if (fs.existsSync(backup)) {
      // Already instrumented — instrumenting again would count the counters themselves.
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(backup, source);
    // Absolute path, matching the keys c8 writes. istanbul merges coverage by file name, so a
    // relative key here would leave the same file present twice in the merged report — once from
    // the Playwright run and once from the unit tier — and neither entry would show the union.
    fs.writeFileSync(file, instrumenter.instrumentSync(source, file));
    count++;
  }
  console.log(`Instrumented ${count} webview script(s) for coverage.`);
}

function restore() {
  let count = 0;
  for (const file of webviewScripts()) {
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) { continue; }
    fs.copyFileSync(backup, file);
    fs.rmSync(backup);
    count++;
  }
  console.log(`Restored ${count} webview script(s).`);
}

// Only act when run as a script. merge-coverage.mjs imports webviewScripts() to report the files
// that produced *no* coverage, and an import must not instrument anything as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "instrument") {
    instrument();
  } else if (command === "restore") {
    restore();
  } else {
    console.error("Usage: node scripts/instrument-webviews.mjs instrument|restore");
    process.exit(2);
  }
}

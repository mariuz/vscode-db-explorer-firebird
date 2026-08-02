/**
 * Runs the Playwright tier with the webviews instrumented for coverage, and restores them
 * afterwards no matter how the run ends — docs/roadmap/webview-ui-testing.md, phase 4.
 *
 * The restore lives here rather than in an `&&` chain in package.json for one reason: an
 * instrumented working tree that is never restored looks like a catastrophic diff over six webview
 * files, and would be easy to commit by accident. A `finally` in a script survives a failing test
 * run, a non-zero exit and a Ctrl-C; a shell chain does not.
 */

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const instrumentScript = path.join(repoRoot, "scripts", "instrument-webviews.mjs");

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit", cwd: repoRoot });
}

function restore() {
  run(process.execPath, [instrumentScript, "restore"]);
}

// Restore on the way out even if the run is interrupted; without this a Ctrl-C leaves the tree
// instrumented.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

let exitCode = 1;
try {
  const instrumented = run(process.execPath, [instrumentScript, "instrument"]);
  if (instrumented.status !== 0) {
    throw new Error("Instrumentation failed");
  }

  const playwright = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["playwright", "test", ...process.argv.slice(2)],
    { stdio: "inherit", cwd: repoRoot }
  );
  exitCode = await new Promise(resolve => playwright.on("close", resolve));
} finally {
  restore();
}

// The merge runs even when specs failed: partial coverage from a partial run is still worth
// reading, and hiding it would make a red run harder to diagnose rather than easier.
run(process.execPath, [path.join(repoRoot, "scripts", "merge-coverage.mjs")]);

process.exit(exitCode);

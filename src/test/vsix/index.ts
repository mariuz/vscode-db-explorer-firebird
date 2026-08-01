/**
 * Mocha bootstrap for the packaged-VSIX smoke test.
 *
 * Unlike the extension-host suite tier (`src/test/suite/`), which @vscode/test-cli discovers and
 * runs for us, this tier is driven by `scripts/smoke-test-vsix.mjs` through
 * @vscode/test-electron's `runTests()`, whose `extensionTestsPath` contract is "a module
 * exporting `run()`". Hence the hand-rolled Mocha instance.
 *
 * Deliberately the plain `spec` reporter, with no JUnit output: this tier is a handful of
 * assertions whose only question is "did the packaged extension load", and the job's exit code
 * answers it. Adding the multi-reporter plumbing here would be another thing that can fail
 * inside the extension host for reasons unrelated to what is being tested.
 */

import * as path from "path";
import Mocha = require("mocha");

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    // Generous: this includes activating the extension for the first time from a cold install.
    timeout: 60_000,
  });

  mocha.addFile(path.resolve(__dirname, "smoke.test.js"));

  return new Promise((resolve, reject) => {
    try {
      mocha.run(failures => {
        if (failures > 0) {
          reject(new Error(`${failures} smoke test${failures === 1 ? "" : "s"} failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

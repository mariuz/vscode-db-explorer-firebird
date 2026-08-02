/**
 * The webview coverage instrumentation scripts — docs/roadmap/webview-ui-testing.md, phase 4.
 *
 * Two properties are worth pinning, because breaking either is silent:
 *
 *  - **Importing the script must not instrument anything.** `merge-coverage.mjs` imports
 *    `webviewScripts()` to list the webviews that produced no coverage, and an import with side
 *    effects would rewrite six source files as a by-product of printing a report.
 *  - **Vendored bundles stay out.** jQuery, DataTables and pdfmake are tens of thousands of lines
 *    nobody will ever write a test for; instrumenting them would drown the numbers this phase
 *    exists to produce.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

// out/test/… -> repository root
const repoRoot = path.join(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "instrument-webviews.mjs");

/**
 * A real dynamic `import()`, hidden from TypeScript.
 *
 * This suite compiles to CommonJS, where `import()` is downlevelled to `require()` — and `require`
 * cannot load an `.mjs` file. Going through the Function constructor keeps a genuine ESM import in
 * the emitted JavaScript.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;

async function loadScript(): Promise<{ webviewScripts: () => string[] }> {
  return await dynamicImport(pathToFileURL(scriptPath).href);
}

suite("instrument-webviews.mjs", function () {
  test("importing it does not instrument, and does not exit", async function () {
    // The CLI block is guarded on the module being the entry point. Without that guard this import
    // would print a usage message and call process.exit(2), taking the whole test run with it.
    const before = fs.readFileSync(path.join(repoRoot, "src", "result-view", "htmlContent", "js", "app.js"), "utf8");
    await loadScript();
    const after = fs.readFileSync(path.join(repoRoot, "src", "result-view", "htmlContent", "js", "app.js"), "utf8");
    assert.strictEqual(before, after, "importing the script must not rewrite a webview source file");
  });

  test("finds the webviews' own scripts", async function () {
    const { webviewScripts } = await loadScript();
    const found = webviewScripts().map(f => path.relative(repoRoot, f).replace(/\\/g, "/"));
    for (const expected of [
      "src/result-view/htmlContent/js/app.js",
      "src/result-view/htmlContent/js/plan-view.js",
      "src/schema-designer/htmlContent/js/app.js",
      "src/query-plan-view/htmlContent/js/app.js",
      "src/profiler/htmlContent/js/app.js",
    ]) {
      assert.ok(found.includes(expected), `${expected} missing from ${JSON.stringify(found)}`);
    }
  });

  test("excludes vendored bundles", async function () {
    const { webviewScripts } = await loadScript();
    const minified = webviewScripts().filter(f => f.endsWith(".min.js"));
    assert.deepStrictEqual(minified, [], "vendored .min.js files must not be instrumented");
  });

  test("leaves no backup file behind in a clean tree", async function () {
    // A `.orig-for-coverage` in the working tree means a run was interrupted before restoring, and
    // the instrumented file it shadows is what would be committed.
    const { webviewScripts } = await loadScript();
    const strays = webviewScripts().filter(f => fs.existsSync(f + ".orig-for-coverage"));
    assert.deepStrictEqual(strays, [], "an instrumented run did not restore these files");
  });
});

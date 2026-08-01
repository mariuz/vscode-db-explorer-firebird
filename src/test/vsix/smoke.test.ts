/**
 * Packaged-VSIX smoke test.
 *
 * Every other tier runs the extension **from source**: the unit tier imports modules directly,
 * and the extension-host suite loads the repository folder via `--extensionDevelopmentPath`.
 * None of them can see a packaging mistake — a file excluded by `.vscodeignore`, an esbuild
 * output that never got built, a manifest pointing at a path that only exists in the working
 * tree. This tier runs against the extension as *installed from a .vsix*, which is the only
 * arrangement where those show up.
 *
 * That this was worth building was settled the first time it ran: packaging revealed that
 * `coverage/` (116 files) and `test-reports/` were being shipped inside the VSIX, because the
 * test-tooling work that created them never touched `.vscodeignore`.
 *
 * Driven by `scripts/smoke-test-vsix.mjs`, not by `vscode-test`.
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const EXTENSION_ID = "AdrianMariusPopa.vscode-firebird-studio";

/** Commands from different feature areas, so a partially-packaged bundle is caught. */
const EXPECTED_COMMANDS = [
  "firebird.explorer.addConnection",
  "firebird.runQuery",
  "firebird.notebook.new",
  "firebird.schemaVisualizer.open",
];

suite("Packaged VSIX – smoke test", function () {
  this.timeout(60_000);

  let extension: vscode.Extension<unknown>;

  suiteSetup(async function () {
    const found = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      found,
      `Extension ${EXTENSION_ID} is not present. The .vsix either failed to install or ` +
        `declares a different publisher/name than the id this test expects.`
    );
    extension = found;
    await extension.activate();
  });

  test("runs from an installed extension directory, not the repository", function () {
    // Guards the premise of this whole tier. If the harness ever regressed to loading the repo
    // folder, every assertion below would still pass while testing nothing about packaging.
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    assert.notStrictEqual(
      path.resolve(extension.extensionPath),
      repoRoot,
      `Expected the installed copy, but the extension loaded from the repository at ${repoRoot}`
    );
  });

  test("activates", function () {
    assert.strictEqual(extension.isActive, true, "Extension should be active after activate()");
  });

  test("registers its commands", async function () {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(registered.has(command), `Command ${command} is not registered`);
    }
  });

  test("the entry point named by the manifest exists in the package", function () {
    const main: string = extension.packageJSON.main;
    assert.ok(main, "package.json must declare `main`");
    assertPackagedFileExists(main, "the extension entry point");
  });

  test("every esbuild output is present, not just the main bundle", function () {
    // Three separate bundles are built (extension, MCP server, notebook renderer) and only the
    // first is referenced by `main`. A build or ignore-rule change can drop either of the other
    // two without anything else noticing, since neither loads until a user reaches that feature.
    for (const bundle of ["out/mcp-server/server.js", "out/sql-notebook/renderer.js"]) {
      assertPackagedFileExists(bundle, "an esbuild output");
    }
  });

  test("the notebook renderer entry point named by the manifest exists", function () {
    const renderers: { id: string; entrypoint: string }[] =
      extension.packageJSON.contributes?.notebookRenderer ?? [];
    assert.ok(renderers.length > 0, "Expected at least one notebookRenderer contribution");
    for (const renderer of renderers) {
      assertPackagedFileExists(renderer.entrypoint, `notebookRenderer "${renderer.id}"`);
    }
  });

  test("webview assets are packaged", function () {
    // These live under src/ rather than out/ — they are copied, not bundled — which makes them
    // exactly the kind of asset a broad `src/**` ignore rule would silently remove.
    for (const asset of [
      "src/result-view/htmlContent/index.html",
      "src/schema-designer/htmlContent/index.html",
      "src/query-plan-view/htmlContent/index.html",
      "src/profiler/htmlContent/index.html",
    ]) {
      assertPackagedFileExists(asset, "a webview asset");
    }
  });

  test("every walkthrough step's markdown is packaged", function () {
    const walkthroughs: { id: string; steps: { id: string; media?: { markdown?: string } }[] }[] =
      extension.packageJSON.contributes?.walkthroughs ?? [];
    assert.ok(walkthroughs.length > 0, "Expected at least one walkthrough contribution");
    for (const walkthrough of walkthroughs) {
      for (const step of walkthrough.steps ?? []) {
        const markdown = step.media?.markdown;
        if (markdown) {
          assertPackagedFileExists(markdown, `walkthrough step "${step.id}"`);
        }
      }
    }
  });

  test("chat instruction files named by the manifest are packaged", function () {
    // These ship as plain Markdown outside out/ and src/, so a broad ignore rule is exactly what
    // would drop them — and their absence is silent: chat simply stops getting the dialect rules.
    const instructions: { path: string }[] = extension.packageJSON.contributes?.chatInstructions ?? [];
    assert.ok(instructions.length > 0, "Expected at least one chatInstructions contribution");
    for (const entry of instructions) {
      assertPackagedFileExists(entry.path, "a chat instructions file");
    }
  });

  test("snippet and grammar files named by the manifest are packaged", function () {
    const contributes = extension.packageJSON.contributes ?? {};
    for (const snippet of contributes.snippets ?? []) {
      assertPackagedFileExists(snippet.path, `snippets for "${snippet.language}"`);
    }
    for (const grammar of contributes.grammars ?? []) {
      assertPackagedFileExists(grammar.path, `grammar for "${grammar.scopeName}"`);
    }
  });

  test("does not ship test or coverage artifacts", function () {
    // The regression this tier was built on. `coverage/` alone was 116 files and 7.9 MB.
    for (const unwanted of ["coverage", "test-reports", "out/test", "node_modules/.bin"]) {
      const full = path.join(extension.extensionPath, unwanted);
      assert.ok(!fs.existsSync(full), `${unwanted} should not be inside the packaged extension`);
    }
  });

  function assertPackagedFileExists(relativePath: string, what: string): void {
    // Manifest paths are conventionally written "./out/x.js"; resolve strips the leading "./".
    const full = path.resolve(extension.extensionPath, relativePath);
    assert.ok(
      fs.existsSync(full),
      `${what} is missing from the packaged extension: ${relativePath} (looked in ${full})`
    );
  }
});

/**
 * Packaged-VSIX smoke test harness.
 *
 * Packages the extension (unless VSIX_PATH points at one already built), installs that .vsix
 * into a throwaway VS Code, and runs `src/test/vsix/` against the *installed* copy. See that
 * directory for why this tier exists — no other tier can see a packaging mistake.
 *
 *   node scripts/smoke-test-vsix.mjs                 # package, then smoke-test
 *   VSIX_PATH=./x.vsix node scripts/smoke-test-vsix.mjs
 *   CODE_VERSION=insiders node scripts/smoke-test-vsix.mjs
 *
 * Note on the runner's shape: @vscode/test-electron's runTests() always passes
 * --extensionDevelopmentPath (out/runTest.js appends it unconditionally), so it is pointed at
 * the *installed* extension directory rather than the repository. The files under test are
 * therefore the ones the CLI unpacked from the .vsix, which is what matters here, even though
 * VS Code loads them in development mode. runTests() also always passes
 * --disable-workspace-trust; the extension declares `untrustedWorkspaces: "limited"` and would
 * activate either way, but the flag keeps the smoke test measuring packaging rather than trust.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXTENSION_ID = "AdrianMariusPopa.vscode-firebird-studio";

/** Temp dirs are per-run so a stale install can never make a broken package look fine. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vsix-smoke-"));
const extensionsDir = path.join(scratch, "extensions");
const userDataDir = path.join(scratch, "user-data");
const workspaceDir = path.join(scratch, "workspace");
for (const dir of [extensionsDir, userDataDir, workspaceDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args, label) {
  console.log(`\n> ${label}\n  ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // Under WSL, `code --install-extension` stops to ask "To use Visual Studio Code with the
      // Windows Subsystem for Linux, please install Visual Studio Code in Windows... Do you want
      // to continue anyway? [y/N]" and then aborts on empty stdin. Irrelevant on a CI runner,
      // fatal for a developer running this from WSL.
      DONT_PROMPT_WSL_INSTALL: "1",
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

/**
 * Must run *after* packaging, never before: `vsce package` triggers `vscode:prepublish`, which
 * runs `npm run compile`, whose esbuild-base step starts with `rimraf out` — wiping out/test
 * along with everything else. Compiling first produces a confusing "Cannot find module
 * out/test/vsix/index.js" from inside the extension host, which is what this ordering prevents.
 */
function compileTestTier() {
  // TypeScript 7 by explicit path — see CONTRIBUTING.md for why a bare `tsc` is the wrong one.
  run(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "typescript7", "bin", "tsc"),
      "-p",
      "tsconfig.suite.json",
      "--noEmitOnError",
      "false",
    ],
    "compile the smoke-test tier"
  );
}

function packageVsix() {
  const out = path.join(scratch, "extension.vsix");
  // Resolve vsce's bin through Node rather than node_modules/.bin, which is a shell script on
  // POSIX and a .cmd shim on Windows — this keeps one code path on every platform.
  const vsce = path.join(repoRoot, "node_modules", "@vscode", "vsce", "vsce");
  // --no-dependencies: the build is bundled by esbuild, and vsce's dependency walk would
  // otherwise try to reason about the native driver packages.
  run(process.execPath, [vsce, "package", "--no-dependencies", "--out", out], "vsce package");
  return out;
}

function installVsix(vscodeExecutablePath, vsixPath) {
  // `reuseMachineInstall: true` suppresses the helper's own --extensions-dir/--user-data-dir
  // defaults (which point at the shared .vscode-test cache). Without it the CLI receives each
  // flag twice — once for the cache and once for this run's scratch dirs — and the install
  // lands somewhere other than where the test then looks.
  const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
    reuseMachineInstall: true,
  });
  run(
    cli,
    [
      ...baseArgs,
      "--install-extension",
      vsixPath,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
    ],
    "code --install-extension"
  );
}

/** The directory the CLI unpacked the .vsix into: <extensionsDir>/<publisher>.<name>-<version>. */
function findInstalledExtensionDir() {
  const prefix = `${EXTENSION_ID.toLowerCase()}-`;
  const match = fs
    .readdirSync(extensionsDir)
    .find(entry => entry.toLowerCase().startsWith(prefix));
  if (!match) {
    throw new Error(
      `The .vsix installed without error, but no ${EXTENSION_ID}-* directory appeared in ` +
        `${extensionsDir}. Found: ${fs.readdirSync(extensionsDir).join(", ") || "(nothing)"}`
    );
  }
  return path.join(extensionsDir, match);
}

async function main() {
  const vsixPath = process.env.VSIX_PATH
    ? path.resolve(repoRoot, process.env.VSIX_PATH)
    : packageVsix();

  if (!fs.existsSync(vsixPath)) {
    throw new Error(`No .vsix at ${vsixPath}`);
  }
  console.log(`\nSmoke-testing ${vsixPath} (${(fs.statSync(vsixPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // After packaging, for the reason documented on compileTestTier().
  compileTestTier();

  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.CODE_VERSION || "stable");
  installVsix(vscodeExecutablePath, vsixPath);

  const installedDir = findInstalledExtensionDir();
  console.log(`\nInstalled to ${installedDir}`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: installedDir,
    extensionTestsPath: path.join(repoRoot, "out", "test", "vsix", "index.js"),
    launchArgs: [
      workspaceDir,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
      "--disable-gpu",
    ],
  });
}

main()
  .then(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log("\nVSIX smoke test passed.");
  })
  .catch(err => {
    // Deliberately left on disk when something fails: the installed extension directory is the
    // evidence you need to see what was or wasn't packaged.
    console.error(`\nVSIX smoke test failed: ${err?.message ?? err}`);
    console.error(`Scratch directory kept for inspection: ${scratch}`);
    process.exitCode = 1;
  });

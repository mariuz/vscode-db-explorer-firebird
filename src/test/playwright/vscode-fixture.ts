/**
 * Playwright fixture that launches a real VS Code with this extension loaded and hands the spec
 * a Page for the workbench.
 *
 * Why this tier exists: every other tier stops at the extension host. The six webviews
 * (`result-view`, `schema-designer`, `query-plan-view`, `profiler`, `data-api-builder`, and the
 * notebook renderer) are verified only by loading their `app.js` under `src/test/webview-harness.ts`,
 * a Proxy-based stub whose own header says it is "intentionally not a real DOM". Nothing has ever
 * confirmed that any of them *renders*. This is where that gets checked.
 *
 * VS Code is Electron, so Playwright drives it through `_electron.launch()` — no browser download
 * is involved. The binary is whatever `@vscode/test-electron` has already cached for the other
 * tiers, so this shares their download rather than fetching its own.
 */

import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

export interface WorkspaceSpec {
  /** Files to create in the workspace folder, keyed by relative path. */
  files?: Record<string, string>;
}

export interface LaunchedVSCode {
  app: ElectronApplication;
  page: Page;
  workspaceDir: string;
}

/**
 * Creates a throwaway workspace folder. Kept per-run rather than shared: VS Code persists a great
 * deal per workspace (trust decisions, view state, editor layout), and a spec that silently
 * depended on a previous run's state would be worse than no spec.
 */
export function makeWorkspace(spec: WorkspaceSpec = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pw-ws-"));
  const files = { [ACTIVATION_FILE]: "-- opened at startup to activate the extension\n", ...spec.files };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

/**
 * Opened at launch so `onLanguage:sql` fires immediately. Without it the extension stays dormant —
 * its only activation events are `onLanguage:sql` and `onNotebook:firebird-notebook` — and the
 * Command Palette caches an empty result: it filters once, when opened, and does not re-filter
 * when the extension host later registers the commands. That is what made the first version of
 * these specs fail against a "No matching commands" row that never went away.
 */
const ACTIVATION_FILE = "activate.sql";

/**
 * Blocks until the extension has actually run. `Global.initStatusBarItems()` creates this status
 * bar item during activation, so its text appearing is proof that `activate()` reached that line —
 * unlike the Activity Bar icon or palette entries, which VS Code renders from the manifest alone
 * whether or not a single line of extension code has executed.
 */
export async function waitForActivation(page: Page): Promise<void> {
  // Opening the Firebird view is what makes the extension do work. `initStatusBarItems()` is
  // called at the end of the tree provider's `getHostNodes()`, so with the view never shown the
  // status bar item is never created and waiting for it would hang forever — which is exactly
  // how this first failed.
  await activityBarItem(page).click();
  await page
    .locator(".statusbar-item", { hasText: "FIREBIRD:" })
    .first()
    .waitFor({ state: "visible", timeout: 120_000 });
}

/** The extension's Activity Bar entry, contributed by `viewsContainers`. */
export function activityBarItem(page: Page) {
  return page.locator('.activitybar [aria-label*="Firebird" i]').first();
}

export async function launchVSCode(workspaceDir: string): Promise<LaunchedVSCode> {
  const executablePath = await downloadAndUnzipVSCode(process.env.CODE_VERSION || "stable");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pw-"));

  const app = await _electron.launch({
    executablePath,
    args: [
      // Load this extension from source. Packaging is the VSIX smoke test's job, not this tier's.
      `--extensionDevelopmentPath=${repoRoot}`,
      `--user-data-dir=${path.join(scratch, "user-data")}`,
      `--extensions-dir=${path.join(scratch, "extensions")}`,
      // The extension declares `untrustedWorkspaces: supported: false`, so without this it would
      // not activate in a freshly created folder at all.
      "--disable-workspace-trust",
      // Noise that would otherwise steal focus from, or overlay, whatever a spec is asserting on.
      "--skip-release-notes",
      "--skip-welcome",
      "--disable-updates",
      "--disable-telemetry",
      "--no-sandbox",
      "--disable-gpu",
      // Without this, SecretStorage tries to reach a system keyring that a headless CI container
      // does not have, and every `secrets.store()` rejects. The failure is near-silent: the
      // connection wizard's save is awaited inside a `.catch(logger.error)`, so the wizard simply
      // ends with no connection, no toast and no error on screen — which cost an afternoon to
      // diagnose. `basic` keeps secrets in an unencrypted file, which is exactly right for a
      // throwaway user-data directory.
      "--password-store=basic",
      workspaceDir,
      // Opening a .sql file at launch triggers `onLanguage:sql`; see ACTIVATION_FILE.
      path.join(workspaceDir, ACTIVATION_FILE),
    ],
    // Generous: a cold start unpacks and activates the extension host.
    timeout: 120_000,
  });

  const page = await app.firstWindow();
  // The workbench renders progressively; every locator below would race a splash screen without
  // waiting for the shell itself to exist first.
  await page.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 120_000 });
  // Every spec starts from "the extension has run", so none of them has to think about it.
  await waitForActivation(page);

  return { app, page, workspaceDir };
}

/**
 * Runs a command through the Command Palette, which is the only entry point a spec can rely on:
 * many of this extension's commands take a tree node argument and cannot be invoked any other way,
 * but the ones that don't are all reachable here.
 */
export async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget .input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(`>${command}`);
  // Let the palette filter before committing — pressing Enter too early runs whatever was
  // highlighted for the previous keystroke.
  await page.locator(".quick-input-list .monaco-list-row").first().waitFor({ timeout: 30_000 });
  await page.keyboard.press("Enter");
}

export const test = base.extend<{ vscode: LaunchedVSCode }>({
  // Playwright's fixture signature requires the destructured-dependencies parameter even when a
  // fixture depends on no other fixture, hence the empty pattern.
  // eslint-disable-next-line no-empty-pattern
  vscode: async ({}, use, testInfo) => {
    const workspaceDir = makeWorkspace();
    const launched = await launchVSCode(workspaceDir);
    await use(launched);

    // A screenshot of the final state is far more useful than a stack trace when a locator fails
    // inside a workbench nobody can see.
    if (testInfo.status !== testInfo.expectedStatus) {
      const shot = testInfo.outputPath("workbench.png");
      await launched.page.screenshot({ path: shot }).catch(() => undefined);
      testInfo.attachments.push({ name: "workbench", path: shot, contentType: "image/png" });
    }
    await launched.app.close().catch(() => undefined);
  },
});

export { expect } from "@playwright/test";

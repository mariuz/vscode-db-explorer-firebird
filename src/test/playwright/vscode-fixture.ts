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
import { test as base, expect as expectFromBase } from "@playwright/test";
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

export interface LaunchOptions {
  /**
   * Whether to bypass the Workspace Trust prompt. Default true — every spec but the trust one
   * wants the extension fully enabled. Pass `false` to land in Restricted Mode, which is the only
   * way to exercise `untrustedWorkspaces: "limited"`.
   */
  trust?: boolean;
}

export async function launchVSCode(workspaceDir: string, options: LaunchOptions = {}): Promise<LaunchedVSCode> {
  const executablePath = await downloadAndUnzipVSCode(process.env.CODE_VERSION || "stable");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pw-"));

  const app = await _electron.launch({
    executablePath,
    args: [
      // Load this extension from source. Packaging is the VSIX smoke test's job, not this tier's.
      `--extensionDevelopmentPath=${repoRoot}`,
      `--user-data-dir=${path.join(scratch, "user-data")}`,
      `--extensions-dir=${path.join(scratch, "extensions")}`,
      // Bypasses the trust prompt for a freshly created folder. Omitted only by the Workspace
      // Trust spec, which needs to *be* in Restricted Mode.
      ...(options.trust === false ? [] : ["--disable-workspace-trust"]),
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

  if (options.trust === false) {
    // Best-effort: on a fresh profile VS Code opens the folder in Restricted Mode without prompting
    // at all, so waiting for a dialog that never appears would hang the launch for a minute and
    // then fail — which is exactly what the first version of this did. When a prompt *is* shown it
    // is modal and has to be declined before anything else can be clicked.
    const decline = page.locator(".monaco-dialog-box .monaco-button", { hasText: /don't trust/i });
    await decline.click({ timeout: 5_000 }).catch(() => undefined);
  }
  // Every spec starts from "the extension has run", so none of them has to think about it.
  await waitForActivation(page);

  // Harvest webview coverage on the way out rather than asking every spec to remember. `close()` is
  // what each of them already calls in afterAll, and once the app is gone the frames — and the
  // counters inside them — are unrecoverable.
  const close = app.close.bind(app);
  app.close = async () => {
    await collectWebviewCoverage(page);
    await close();
  };

  return { app, page, workspaceDir };
}

/** Where a run's raw webview coverage lands, for scripts/merge-coverage.mjs to combine. */
const WEBVIEW_COVERAGE_DIR = path.join(repoRoot, "coverage", ".tmp-webview");

/**
 * Reads istanbul's counters out of every webview frame in `page` and writes them to disk.
 *
 * Only does anything when the webview JS has been instrumented (`npm run test:playwright:coverage`);
 * an ordinary run finds no `__coverage__` and writes nothing, which is why this can be unconditional.
 *
 * Every step is guarded: frames detach as panels close, and an evaluate against a frame that has
 * gone away throws. Coverage is a by-product of this tier, so it must never be able to fail a spec.
 */
export async function collectWebviewCoverage(page: Page): Promise<void> {
  const collected: unknown[] = [];
  for (const frame of page.frames()) {
    try {
      // The expression is a string rather than a callback: this file is also compiled by
      // tsconfig.test.json, whose `lib` has no DOM, so naming `window` in TypeScript would break
      // the unit tier's build. Playwright evaluates a string in the page just as happily.
      const data = await frame.evaluate("window.__coverage__");
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        collected.push(data);
      }
    } catch {
      // Detached, cross-origin, or simply not a webview — nothing to collect.
    }
  }
  if (collected.length === 0) {
    return;
  }
  fs.mkdirSync(WEBVIEW_COVERAGE_DIR, { recursive: true });
  for (const data of collected) {
    // Content-addressed by a counter, not by time: the specs run sequentially and several may
    // contribute, and a name collision would silently drop one file's worth of coverage.
    const name = `webview-${process.pid}-${coverageFileCounter++}.json`;
    fs.writeFileSync(path.join(WEBVIEW_COVERAGE_DIR, name), JSON.stringify(data));
  }
}

let coverageFileCounter = 0;

/**
 * Runs a command through the Command Palette, which is the only entry point a spec can rely on:
 * many of this extension's commands take a tree node argument and cannot be invoked any other way,
 * but the ones that don't are all reachable here.
 */
export async function runCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(".quick-input-widget .input");
  // Opening the palette is retried rather than awaited once. The quick-input widget also backs
  // extension-owned prompts, not just the palette, so always dismiss any already-open quick input
  // first and then reopen the palette explicitly.
  await expectFromBase(async () => {
    if (await input.isVisible()) {
      await page.keyboard.press("Escape");
      await input.waitFor({ state: "hidden", timeout: 5_000 });
    }
    await page.keyboard.press("Control+Shift+P");
    await input.waitFor({ state: "visible", timeout: 5_000 });
    await input.fill(`>${command}`, { timeout: 5_000 });
    // Let the palette filter before committing — pressing Enter too early runs whatever was
    // highlighted for the previous keystroke.
    await page.locator(".quick-input-list .monaco-list-row").first().waitFor({ timeout: 5_000 });
    await page.keyboard.press("Enter");
  }).toPass({ timeout: 60_000 });
}

/**
 * Adds a saved connection and makes it active, via the wizard's paste-a-connection-string path:
 * one palette command and one input box, after which `saveNewConnection()` has stored the
 * password in SecretStorage and set the connection active.
 *
 * This is the only route a spec can take. A workspace `.vscode/firebird.json` connection cannot
 * carry a password by design, and the only way to give one to it is the tree's context menu —
 * `firebird.database.setPassword` takes a NodeDatabase argument and is not reachable from the
 * palette.
 */
export async function addConnection(page: Page): Promise<void> {
  const host = process.env.FIREBIRD_HOST ?? "localhost";
  const port = process.env.FIREBIRD_PORT ?? "3050";
  const database = process.env.FIREBIRD_DATABASE;
  const user = process.env.FIREBIRD_USER ?? "SYSDBA";
  const password = process.env.FIREBIRD_PASSWORD ?? "masterkey";
  // Only when asked for, matching the e2e tier's FIREBIRD_WIRE_CRYPT convention — a stock
  // Firebird 4+ install defaults to WireCrypt=Enabled.
  const wireCrypt = process.env.FIREBIRD_WIRE_CRYPT ? `?wireCrypt=${process.env.FIREBIRD_WIRE_CRYPT}` : "";

  await runCommand(page, "Firebird: Add New Connection");

  // Wait for the wizard's *own* prompt, not merely for a visible input: the Command Palette and
  // the wizard share this selector, so filling as soon as an input exists can type into the
  // palette that is still closing.
  await page
    .locator(".quick-input-widget", { hasText: "Paste a Firebird connection string" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .locator(".quick-input-widget .input")
    .fill(`firebird://${user}:${password}@${host}:${port}/${database}${wireCrypt}`);
  await page.keyboard.press("Enter");

  // The status bar stops saying "No active database" once the connection is saved and activated —
  // a deterministic signal that the wizard got all the way through, rather than a sleep.
  await expectFromBase(page.locator(".statusbar-item", { hasText: "FIREBIRD:" }).first()).not.toContainText(
    "No active database",
    { timeout: 60_000 }
  );
}

/** Runs the SQL currently in the active editor and waits for the results webview to appear. */
export async function runQueryInEditor(page: Page): Promise<void> {
  // `runQuery` reads `window.activeTextEditor`, which is undefined unless the editor is the
  // focused part — the palette and the wizard both leave focus elsewhere.
  await page.locator(".monaco-editor").first().click();
  await runCommand(page, "Firebird: Run Firebird Query");
}

/** VS Code nests webview content two iframes deep: the workbench's frame, then the extension's. */
export function webviewFrame(page: Page) {
  return page.frameLocator("iframe.webview").frameLocator("#active-frame");
}

/**
 * Asserts a webview has rendered the given text.
 *
 * The explicit wait for the outer iframe *element* first is load-bearing: asserting straight
 * through the two-deep frameLocator chain while the webview is still being created reports
 * "element(s) not found" and never recovers, even with a generous timeout — the chain resolves
 * against a frame tree that is still changing underneath it. Waiting for the container element to
 * be attached first makes the frame lookup deterministic.
 */
export async function expectWebviewText(page: Page, text: string, timeout = 60_000): Promise<void> {
  await page.locator("iframe.webview").first().waitFor({ state: "attached", timeout });
  await expectFromBase(webviewFrame(page).locator("body")).toContainText(text, { timeout });
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

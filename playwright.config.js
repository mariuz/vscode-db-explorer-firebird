"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
/**
 * Playwright drives a real VS Code (Electron) with this extension loaded — see
 * `src/test/playwright/vscode-fixture.ts` and docs/roadmap/webview-ui-testing.md.
 *
 * The settings below are conservative on purpose. This tier launches a desktop application per
 * test; it is inherently slower and more fragile than anything else in the repository, which is
 * why it runs nightly rather than on every pull request, and why failures produce a screenshot,
 * a video and a trace rather than a bare assertion message.
 */
exports.default = (0, test_1.defineConfig)({
    testDir: "./src/test/playwright",
    testMatch: ["**/*.spec.ts"],
    // One VS Code at a time. Parallel Electron instances contend for the display and, on a CI
    // runner, for memory.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    // A cold VS Code start plus extension activation plus a database round trip.
    timeout: 3 * 60 * 1000,
    expect: { timeout: 30000 },
    reporter: process.env.CI
        ? [["list"], ["junit", { outputFile: "test-reports/playwright.xml" }]]
        : [["list"]],
    use: {
        trace: "on-first-retry",
        video: "retain-on-failure",
        screenshot: "only-on-failure",
    },
});
//# sourceMappingURL=playwright.config.js.map
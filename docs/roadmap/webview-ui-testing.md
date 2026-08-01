# Webview UI testing and VSIX smoke tests (Playwright)

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s smoke-test tier — `playwright.config.ts`, `test/e2e/*.spec.ts`, `test/e2e/baseFixtures.ts`, `test/e2e/README_webviewTesting.md`, and the `smoketest` npm script. It is the one part of their setup that tests something this repo currently cannot test at all. (vscode-pgsql's public repository has no source or tests, so it contributes nothing here.)

## What vscode-mssql actually does

- **`npm run smoketest` = `npm run instrument && npm run e2eTest`** — nyc-instrument the built webview bundles in place (`nyc instrument ./dist/views ./dist/views --in-place`), then `npx playwright test` followed by an `nyc report` scoped to `src/webviews/pages/**/*.tsx`.
- **Playwright launches a real VS Code** (Electron) with the extension loaded — `test/e2e/utils/launchVscodeWithMsSqlExt.ts` — and drives the actual UI: `activityBar.spec.ts`, `connection.spec.ts`, `queryExecution.spec.ts`, `executionPlan.spec.ts`, and **`vsix.spec.ts`**.
- **Webview coverage is collected from the running browser context**: `baseFixtures.ts` (adapted from `mxschmitt/playwright-test-coverage`) registers a `beforeunload` listener that ships `window.__coverage__` out through an exposed function into `.nyc_output`, then merges it with the unit-test coverage.
- **CI shape** (`build-and-test.yml`): a real SQL Server 2025 container with a randomly generated SA password, `DISPLAY=:10` for headed Electron, `retries: 2` / `workers: 1` / `fullyParallel: false` / 5-minute timeout, JUnit XML into a "Smoke Test Report" check, and screenshots + videos uploaded as a 7-day artifact on failure.
- **Their own documented limitation**, quoted from `README_webviewTesting.md`: *"there's no way to access VSCode elements that run outside the playwright context; For example, things like the VSCode save dialog, or alert popups."* Any plan here inherits that constraint — export flows that end in `showSaveDialog()` cannot be driven end to end.

## Current state in Firebird Studio

**Six webviews, none of them ever rendered by a test.** The extension's UI surface is unusually webview-heavy — `result-view`, `schema-designer`, `query-plan-view`, `profiler`, `data-api-builder`, and the SQL Notebook renderer — and every one of them is verified today by loading its `app.js` under a **stub DOM**:

- `src/test/webview-harness.ts` (149 lines) is a Proxy-based fake where "any unrecognized property read returns a no-op function" and `getElementById`/`querySelector` "always return another such stub element rather than `null`". Its own header says it plainly: *"This is intentionally not a real DOM: it only exists to get a file past its module-load-time setup so the `__test__` hook's already-documented-as-pure functions can be called"*, and that anything needing "real layout/rendering state (e.g. schema-designer's `render()`/`measureAll()`, which need genuine text-measurement/SVG geometry) is out of scope".
- The four `*-webview.test.ts` files therefore cover **pure functions only** — `sqlLiteral`, `buildDDL`, `layoutForest`, `matchesFilter`, `computeSelectionStats`, `buildSparklineSvg`, and so on. `sql-notebook-renderer.test.ts` goes further with a stateful fake DOM (it needs to read rendered output back), but it is still not a browser.
- Every design doc that touches a webview records the same boundary in its Testing section — *"webview inline JS DOM wiring isn't independently tested"*, *"the real webview's guard is client-side, same boundary as everything else"*. It is a consistently applied, honestly documented decision, not an oversight. But it means **no test has ever confirmed that any of these six webviews renders**: a broken selector, a JS error at load, a CSS regression, or a message-protocol mismatch between extension host and webview all ship silently.
- **Nothing tests the packaged extension either.** The suite tier runs from source via `extensionDevelopmentPath`, so anything that goes wrong only in a real install — a file excluded by `.vscodeignore`, a missing bundled asset, an esbuild external that isn't present at runtime — is invisible to all three tiers. This repo bundles three separate esbuild outputs (`extension.js`, `mcp-server/server.js`, the notebook renderer) plus `htmlContent/` asset trees, which is exactly the packaging surface that breaks quietly.

## Proposed feature

- **A Playwright tier driving real VS Code**, modeled on mssql's `launchVscodeWithMsSqlExt.ts` (Playwright's `_electron.launch()` against the VS Code binary `@vscode/test-electron` already downloads for the suite tier, with `--extensionDevelopmentPath`). Highest-value specs, in order: the **results grid** (sort, filter, page, column freeze/hide, Text View toggle — all currently pure-function-only), the **Schema Designer** (`render()`/`measureAll()`, explicitly out of scope for the stub DOM and the most geometry-dependent code in the repo), and the **query plan view** (SVG diagram rendering).
- **A VSIX install smoke test** — mssql's `vsix.spec.ts`. Package with `vsce`, install it into the test VS Code, activate, run one command, assert a result. This is the cheapest high-value item on this page: it needs no webview automation, catches a whole class of packaging regressions nothing else can see, and the packaging step is a prerequisite for publishing anyway (see the Open VSX item in the roadmap).
- **Webview coverage from the Playwright run** using mssql's `window.__coverage__` fixture — but only *after* [test-coverage-and-reporting.md](test-coverage-and-reporting.md) phase 1 exists, since it merges into the same report. Note this one does require nyc-style instrumentation of the built webview JS (V8 coverage does not reach inside the webview iframe), so it is the only place `nyc` earns its place in `devDependencies`.
- **Run it on a schedule, not on every PR.** mssql's own configuration is a candid admission of how fragile this tier is: `workers: 1`, `fullyParallel: false`, `retries: 2` on CI, a 5-minute per-test timeout, video-on-failure, trace-on-first-retry, and `continue-on-error` in the workflow. A nightly job with screenshot/video artifacts gives most of the value without putting a flaky Electron launch in the merge path.
- **Reuse the existing Firebird provisioning.** The specs need a live server; `e2e.yml` (12-job service-container matrix) and `vscode-host.yml` (Firebird 6 from tar.gz) already solve this two different ways, and `src/test/suite/firebird-test-env.ts` already centralizes the connection env vars.

## Risks

- **Headed Electron in CI needs a display** (`xvfb`; mssql exports `DISPLAY=:10`) and cannot run while another instance of the same VS Code version is open — mssql's README calls this out for local runs and recommends developing against Insiders so tests can run on stable.
- **Native VS Code dialogs are unreachable** (mssql's documented limitation above). Several flows here end in `showSaveDialog()` — results export, notebook export, backup/restore paths — so those specs must stop at the dialog boundary, and the doc should say so rather than leaving a half-covered flow looking covered.
- **This tier is slow and duplicative if overbuilt.** The pure-function coverage that already exists is fast and precise; Playwright should cover *rendering and wiring*, not re-assert logic already unit-tested. Keeping that split explicit is what stops this from becoming a second, slower copy of the existing suite.

## Suggested phases

1. **VSIX packaging + install smoke test** — no webview automation, immediate value, and a prerequisite for publishing. Can run on every PR.
2. **Playwright harness**: launch real VS Code with the extension, one spec that opens the results grid and asserts it renders a known query's rows. Nightly, with artifacts on failure.
3. **Broaden the specs** to the Schema Designer's real geometry and the plan view's SVG — the two places the stub DOM explicitly cannot reach.
4. **Webview coverage** via the instrumented-bundle fixture, merged into the coverage report from phase 1 of the coverage doc.

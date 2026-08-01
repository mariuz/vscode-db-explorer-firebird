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

## Phase 1 — VSIX packaging and install smoke test (done)

`npm run test:vsix` packages the extension, installs the `.vsix` into a throwaway VS Code, and runs ten assertions against the **installed** copy. New CI workflow `vsix-smoke.yml` does the same on every push and pull request, and uploads the `.vsix` as an artifact. It needs no Firebird server — the question is whether the packaged extension installs, activates and registers its commands, not whether it can query anything.

**It found a real defect on its first run, which is the entire argument for the tier.** The package contained `coverage/` (116 files, 7.86 MB) and `test-reports/` — the coverage and JUnit tooling added in [test-coverage-and-reporting.md](test-coverage-and-reporting.md) phases 1–2 wrote into directories that `.gitignore` knew about but `.vscodeignore` did not. **230 files / 4.8 MB → 111 files / 3.55 MB** once fixed. Nothing else in the repository could have caught it: `.vscodeignore` affects only packaging, and until now nothing packaged.

### What it asserts

Beyond "it activates", the checks are **data-driven from the manifest**, so they keep working as the manifest grows: every path `package.json` names must exist inside the installed extension — `main`, each `notebookRenderer` entrypoint, every walkthrough step's markdown, every `snippets`/`grammars` path. Plus the two esbuild outputs that *no* manifest path references (`out/mcp-server/server.js`, `out/sql-notebook/renderer.js`) and which therefore nothing else would notice the absence of until a user reached that feature; the webview `htmlContent` assets, which live under `src/` and are copied rather than bundled, making them the prime casualty of any broad `src/**` ignore rule; and a negative assertion that `coverage`, `test-reports`, and `out/test` are *not* present, so the defect above cannot silently return.

One assertion guards the harness itself: `extensionPath` must not be the repository root. Without it, a regression in the runner that quietly loaded the source folder would leave every other assertion passing while testing nothing about packaging.

**The failure mode was verified, not assumed**: adding `out/mcp-server` to `.vscodeignore` and re-running produced exactly one failure — `an esbuild output is missing from the packaged extension: out/mcp-server/server.js` — and exit code 1.

### Three things worth knowing before touching the harness

- **`vsce package` deletes the compiled tests.** It triggers `vscode:prepublish` → `npm run compile` → `esbuild-base`, which begins with `rimraf out`. Compiling the smoke-test tier *before* packaging therefore produces a baffling `Cannot find module out/test/vsix/index.js` from inside the extension host. `scripts/smoke-test-vsix.mjs` owns the ordering — package first, compile second — which is why `npm run test:vsix` is just the script and not a chain of `&&`.
- **`runTests()` always passes `--extensionDevelopmentPath`** (appended unconditionally in `@vscode/test-electron`'s `out/runTest.js`), so it cannot be omitted to test a purely installed extension. It is pointed at the directory the CLI unpacked the `.vsix` into, so the files under test are the packaged ones even though VS Code loads them in development mode. `runTests()` also always passes `--disable-workspace-trust`, which this extension now *needs* in order to activate at all — `capabilities.untrustedWorkspaces` is `supported: false` as of phase 5 of the coverage doc.
- **Two local-environment traps**: `resolveCliArgsFromVSCodeExecutablePath()` injects its own `--extensions-dir`/`--user-data-dir` pointing at the shared `.vscode-test` cache unless called with `{ reuseMachineInstall: true }`, which otherwise duplicates those flags and installs the extension somewhere other than where the test looks; and under WSL the CLI stops to ask "Do you want to continue anyway? [y/N]" and aborts on empty stdin, so the harness sets `DONT_PROMPT_WSL_INSTALL=1`. Neither affects a CI runner; both stop a developer from running this locally.

On failure the scratch directory is deliberately left on disk — the unpacked extension directory is the evidence for what was and was not packaged.

### Not covered

The extension's own `out/**/*.js.map` sourcemaps are packaged (11.37 MB of the 3.55 MB compressed total). That is pre-existing and arguably deliberate — they make user-reported stack traces readable — so this phase did not change it, but it is the obvious lever if package size ever becomes a concern.

## Suggested phases

1. ~~**VSIX packaging + install smoke test** — no webview automation, immediate value, and a prerequisite for publishing. Can run on every PR.~~ — **done**, see above; it found a packaging defect on its first run.
2. **Playwright harness**: launch real VS Code with the extension, one spec that opens the results grid and asserts it renders a known query's rows. Nightly, with artifacts on failure.
3. **Broaden the specs** to the Schema Designer's real geometry and the plan view's SVG — the two places the stub DOM explicitly cannot reach.
4. **Webview coverage** via the instrumented-bundle fixture, merged into the coverage report from phase 1 of the coverage doc.

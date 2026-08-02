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

## Phase 2 — the Playwright harness, and the first rendered webview (done)

**A webview in this extension has now been proven to render.** `results-grid.spec.ts` adds a connection through the wizard, runs `SELECT 8675309 AS ANSWER FROM RDB$DATABASE` against a real Firebird server, and asserts that the value appears inside the results webview's document. That is the assertion the stub-DOM tests structurally cannot make.

`npm run test:playwright`. Five specs, ~40 s: four workbench-level ones that need no database, and the results-grid one that does.

- **The harness** is `src/test/playwright/vscode-fixture.ts` — `_electron.launch()` against the VS Code binary `@vscode/test-electron` already caches for the other tiers (no browser download, no second copy of VS Code). It creates a throwaway workspace, user-data and extensions directory per run, and screenshots the workbench on failure.
- **Webview traversal**: VS Code nests webview content two iframes deep — the outer `iframe.webview` belongs to the workbench, the inner `#active-frame` is the extension's own document, so `page.frameLocator("iframe.webview").frameLocator("#active-frame")` is the way in.
- **Where it runs**: inside the existing `vscode-host.yml` job, gated to `schedule`/`workflow_dispatch`. That reuses the Firebird server and VS Code download that job already provisions instead of duplicating ~60 lines of setup, while keeping this tier off the merge path. `CODE_VERSION` is pinned to `stable` even on the nightly — the Insiders run in the same job is about API breakage, and pointing DOM selectors at Insiders too would mostly produce noise from workbench markup churn.

### Five things that had to be discovered by failing

Every one of these produced a silent or misleading failure, and each is now a comment at the point it bites:

1. **`--password-store=basic` is mandatory.** Without it SecretStorage tries to reach a system keyring no headless container has, and every `secrets.store()` rejects. The symptom is brutal: `saveNewConnection`'s failure is awaited inside a `.catch(logger.error)`, so the connection wizard just... ends. No connection, no toast, no error on screen. Nothing in the UI says anything went wrong.
2. **The Command Palette filters once and never re-filters.** Opening it before the extension host has registered the commands leaves a "No matching commands" row that never updates, and `waitFor` happily accepts that row as "a row appeared". The fixture now opens a `.sql` file at launch to force `onLanguage:sql` activation before any spec runs.
3. **The activation signal is not where you would guess.** The Activity Bar icon and palette entries are rendered from the manifest alone, whether or not a line of extension code has run. The status bar item is real proof — but it is created in `Global.initStatusBarItems()`, which is called from the *tree provider's* `getHostNodes()`, so it only exists once the view has been opened. Waiting for it without opening the view hangs forever.
4. **The palette and the wizard share `.quick-input-widget .input`.** Filling as soon as an input is visible can type into the palette that is still closing. Wait for the wizard's own prompt text, not for an input.
5. **A database file the server cannot read fails as a *query* error, not a connection error.** A scratch database created with local `isql` is owned by the developer; the server runs as `firebird` and gets `Permission denied` on open — while the connection itself appears to succeed and the status bar happily shows the database name. Create scratch databases *through* the server (`CREATE DATABASE 'localhost/3050:/path'`), which is what `vscode-host.yml` already does.

### A finding worth acting on separately

`firebird.database.setPassword` takes a `NodeDatabase` argument, so it is **not invocable from the Command Palette** — the only way to give a workspace connection (`.vscode/firebird.json`, which by design cannot carry a password) its password is the tree's context menu. The spec works around this by using the wizard's paste-a-connection-string path instead. A palette-invocable variant that falls back to the existing `connection-picker.ts` would be a small usability improvement in its own right, and would make workspace connections testable directly. Not done here — it is a product change, not a testing one.

## Phase 3 — Schema Designer and plan view (both done)

**Update.** The Schema Designer half is now covered, and what unblocked it was not a testing change at all: `firebird.schemaVisualizer.open` learned to fall back to the connection picker when invoked without a tree node, so the Command Palette can reach it. Lead 2 below diagnosed the blockage correctly — the command was tree-only — but treated it as something the test had to work around rather than something the product should fix. Making it palette-invocable removed the problem entirely, and `schema-designer.spec.ts` now drives the real designer and asserts a table name appears inside the webview, which is the first time `render()`/`measureAll()` have run in any test.

**The plan view half is now done too, and it found two real bugs** — which is the clearest justification this tier has produced.

Lead 3 said "Show Graphical Query Plan did not render within 60s ... whether it needs a selection, a saved file, or something else is unknown". It was neither: the webview *did* open, and rendered `No SQL document opened!`. The plan is fetched when the webview reports "ready", by which point the webview has taken focus and `window.activeTextEditor` is undefined — a non-text editor is active. The command now captures the editor's SQL *before* opening the view. This affects real users, not just tests: running the command from the palette with a `.sql` file open produced that error.

Underneath it was a second bug. With the error fixed, the diagram reported `Couldn't parse the plan: Expected "PLAN" but found "--"` — precisely the confusing parse error `PLAN_FALLBACK_PREFIXES` exists to prevent. `renderIndexMetadataPlan()` has **three** return paths (no tables; tables but no index rows; tables with index rows) and the prefix list covered only the first and third, so a table without indexes fell through to the parser. `src/test/plan-parser.test.ts` now drives all three shapes straight out of `renderIndexMetadataPlan()` rather than from hand-copied strings, so the two cannot drift apart again.

The spec asserts the native-driver message rather than a diagram, because that is the branch a default install actually reaches — a real `PLAN (...)` string needs `firebird.useNativeDriver`.

### Superseded: the original "not delivered" record

> Everything from here to the end of this phase was written when both halves had failed, and the
> **Update** above replaces it: the Schema Designer and the plan view are both covered, and
> `render()`/`measureAll()` run in `schema-designer.spec.ts`. Of the three leads below, **2 and 3
> are resolved** — each is struck through with what actually happened — and **only lead 1 is still
> open**. Kept rather than deleted because the leads record how each blockage was diagnosed, which
> is worth having; annotated in place because a confident "here is what remains" list is exactly
> what gets read as current, however out of date the prose above it says it is. That is not
> hypothetical — this block was read as live work, and the Update was missed, because the leads
> read like the newest thing in the section.

**Originally recorded as not delivered:** Specs for both were written and neither could be made to pass, so neither was kept — a spec that does not pass is worse than no spec, and one that passes for the wrong reason is worse still. What was kept is the harness work that came out of the attempt: `addConnection()`, `runQueryInEditor()` and `expectWebviewText()` are now shared helpers in the fixture, and `results-grid.spec.ts` uses them.

`expectWebviewText()` is worth keeping regardless of phase 3. Asserting straight through the two-deep `frameLocator` chain while a webview is still being created reports `element(s) not found` and never recovers, even with a 60-second timeout — the chain resolves against a frame tree that is still changing underneath it. Waiting for the outer `iframe.webview` *element* to be attached first makes the lookup deterministic.

Three concrete leads for whoever picks this up, all established by failing rather than by guessing — **only the first is still open**:

1. **When the results webview opens is not obvious, and a spec cannot assume it.** A DDL-only run reports through a notification (`Info: Create executed successfully.`) and opens no webview at all. A mixed `RECREATE TABLE …; SELECT …;` batch opened a grid containing *both* statements in a one-off debug run, but the same batch inside a spec never produced one within 60 s. Pin down the actual rule in `runSqlBatch()`/`displayBatch()` before writing a spec that waits on it — this may be a product question (should a mixed batch show its SELECT results?) rather than a test one.
2. ~~**The Schema Designer can only be opened from the tree.** `firebird.schemaVisualizer.open` is contributed as a `view/item/context` menu on `viewItem == database` and takes a `NodeDatabase`, so the palette cannot invoke it. Right-clicking a `.monaco-list-row` matched by name produced VS Code's generic "Copy Text" menu instead of the tree's, so the row targeting needs to be worked out properly: expand the host node first, then identify the database row within `.sidebar` specifically.~~ — **resolved**, and the diagnosis was right while the proposed fix was wrong: the row targeting never needed to be worked out, because the command became palette-invocable. See the Update above.
3. ~~**"Show Graphical Query Plan" did not render within 60 s** with a `SELECT` in the active editor and an active connection. Whether it needs a selection, a saved (non-dirty) file, or something else is unknown — that is the first thing to check.~~ — **resolved**: none of those. The webview opened and rendered `No SQL document opened!`, because the plan was fetched after the webview had taken focus. Two real product bugs, both fixed. See the Update above.

~~The value here is still real: the Schema Designer's `render()`/`measureAll()` are precisely what `src/test/webview-harness.ts` names as out of its scope, so they remain the least-tested code in the repository.~~ — **no longer true.** `render()`/`measureAll()` execute in `schema-designer.spec.ts`, which is what took `schema-designer/app.js` to 78.6% merged. What is *not* asserted is layout correctness: the spec proves a table name reached the webview's document, not that boxes avoid overlapping or that an edge joins the right two columns. That is the remaining slice here, and it is a much narrower one than this sentence claims.

## Phase 4 — webview coverage (done)

`npm run test:playwright:coverage` runs the Playwright specs with the webviews' JavaScript instrumented, harvests istanbul's counters out of each webview frame, and merges them with the unit tier's coverage of the same files. It answers a question nothing could answer before — **how much of the ~6 000 lines of webview code has any test ever executed?**

```
Webview scripts:
    0.0%  src/mock-data/htmlContent/js/app.js   (no test has executed this file)
   26.9%  src/mock-data/htmlContent/js/formHelpers.js
  100.0%  src/mock-data/htmlContent/js/formOptions.js
   87.5%  src/profiler/htmlContent/js/app.js
   61.0%  src/query-plan-view/htmlContent/js/app.js
   68.0%  src/result-view/htmlContent/js/app.js
   66.2%  src/result-view/htmlContent/js/plan-view.js
   78.6%  src/schema-designer/htmlContent/js/app.js
```

**Why instrumentation rather than V8 coverage.** c8 reads V8's counters from the Node process; a webview runs in an Electron *renderer* iframe the extension host cannot see. The only way to learn what ran inside one is to make the code count for itself. This is the one place `nyc`-style instrumentation earns its keep, exactly as this doc predicted.

**Three sources, merged.** The first version of this report was wrong, and wrong in the most misleading direction: it labelled five files "never executed by any test" when the unit tier loads them directly through `src/test/webview-harness.ts` and covers them well — the Profiler's `app.js` was reported at 0.0% when it was in fact at 74%. The cause was that `coverage/unit/` only contains `src/**/*.ts`: widening `.c8rc.json` to include the webview JS drags ~6 000 lines of mostly-DOM code into the *gated* report and drops it from 71.4% to 68.5%, failing a threshold for reasons unrelated to the change. So a second, ungated c8 run (`npm run test:coverage:webviews`) collects those files alone, and the merge unions all three sources.

Getting a union rather than two half-reports also required the instrumenter to key files by **absolute** path, matching c8. With a relative key the same file appeared twice in the merged report and each entry showed only its own tier's number — which is why `result-view/app.js` first read 25.1% (Playwright alone) rather than 68.0% (both).

Other decisions worth recording:

- **Instrumented in place, restored in a `finally`.** A webview loads its assets by path from `src/…/htmlContent/js/`, so serving an instrumented copy from elsewhere would mean teaching every view a second asset root purely for tests. The restore lives in a wrapper script rather than a shell `&&` chain because an instrumented tree that is never restored looks like a catastrophic six-file diff and would be easy to commit by accident; a `finally` survives a failing run, a non-zero exit and a Ctrl-C.
- **Vendored bundles are excluded** by a `.min.js` filter — instrumenting jQuery, DataTables and pdfmake would drown the numbers that matter.
- **Files with no coverage are listed, not omitted**, and the label now means "no test in any tier", not "no Playwright spec".
- **No threshold.** The unit gate still fails the build; gating on a number nobody has aimed at yet would only invite lowering it.
- **The specs are unchanged.** Collection hooks `app.close()`, which every spec already calls in `afterAll`.

Four unit tests cover the scripts themselves, because both properties they pin fail silently: importing the instrumenter script must not instrument anything (`merge-coverage.mjs` imports it), and a stray `.orig-for-coverage` means an interrupted run left instrumented source in the tree.

## Phase 5 — closing the gaps the report exposed (done)

The report immediately paid for itself by naming what nothing had ever run.

**Mock Data was the only genuinely untested webview** — 0% across all three tiers. Its three scripts now have the `module.exports.__test__` hook the other four webviews already use, and 15 unit tests take `formOptions.js` to **100%**. What they pin is the coupling *between* the files, which nothing else checks and which fails silently in every direction: `app.js` wires each row's autocomplete against an element id that `formOptions.js` generates, `validateForm()` scans for a class that `mockSearchInput()` emits, and `checkForm()` validates against the same `dataTypes()` list the form is built from. Also pinned: a `NOT NULL` column's null-percentage input is disabled, because Mockaroo would otherwise cheerfully generate nulls for it and the INSERT would fail on the server.

`mock-data/app.js` stays at 0% and honestly so: the panel never opens without a Mockaroo API key — `NodeTable.generateMockData()` refuses before creating the webview — so covering it would need a live third-party account. `formHelpers.js` stops at 26.9% for a related reason: `populateForm`/`parseForm` are jQuery DOM manipulation, and exercising them against the stub DOM would assert the stub's behaviour rather than the code's.

**The Live Profiler had 74% of its logic covered but had never rendered.** It now has a Playwright spec, which took it to **87.5%** — and, as with the Schema Designer in phase 3, reaching it needed a product fix rather than a test trick: `firebird.database.monitorDatabase` was contributed only as a tree context menu and took a `NodeDatabase`, so the Command Palette could not invoke it. It now falls back to the connection picker, which makes the Live Profiler reachable for users who have the tree scrolled or collapsed, not only for the test.

The first run of that spec found something no amount of reading would have: the panel rendered perfectly and showed **"No other active connections."** The profiler's query excludes `CURRENT_CONNECTION` — it reports *other* activity — so with only the profiler attached there is nothing to render. The spec now holds its own Firebird attachment open for its duration. It also drives the view-mode buttons and the pause toggle, neither of which the stub DOM can meaningfully exercise: its `classList` is a no-op, so pane switching is invisible to the unit tier.

## Suggested phases

1. ~~**VSIX packaging + install smoke test** — no webview automation, immediate value, and a prerequisite for publishing. Can run on every PR.~~ — **done**, see above; it found a packaging defect on its first run.
2. ~~**Playwright harness**: launch real VS Code with the extension, one spec that opens the results grid and asserts it renders a known query's rows. Nightly, with artifacts on failure.~~ — **done**, see above.
3. ~~**Broaden the specs** to the Schema Designer's real geometry and the plan view's SVG.~~ — **done**. The Schema Designer needed its command to become palette-invocable; the plan view needed two product bugs fixed, both found by the spec itself.
4. ~~**Webview coverage** via the instrumented-bundle fixture, merged into the coverage report from phase 1 of the coverage doc.~~ — **done**, see above.
5. ~~**Close the gaps the coverage report names**~~ — **done** (phase 5): Mock Data's form scripts and the Live Profiler's rendering. All five phases of this doc are complete.

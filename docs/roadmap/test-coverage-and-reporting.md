# Test coverage measurement, reporting, and platform matrix

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s test pipeline, reviewed from its actual configuration rather than its docs — `codecov.yml`, `extensions/mssql/package.json`, `.vscode-test.mjs`, `scripts/vscode-test-config.mjs`, and `.github/workflows/build-and-test.yml`. (vscode-pgsql could not be reviewed: its public repository contains only `README.md`, `CHANGELOG.md`, license/support files and images — no source, no tests, no workflows. There is nothing to compare against, and any claim about how pgsql tests would be invention.)

## What vscode-mssql actually does

| | vscode-mssql | Firebird Studio today |
| --- | --- | --- |
| Unit test host | Real VS Code (**Insiders**) via `@vscode/test-cli`; no `vscode` mock | Plain Mocha + a hand-written 323-line `vscode` stub |
| Test doubles | `sinon` 21, `chai` 5, `sinon-chai` | none — hand-rolled fakes per test |
| Unit test count | 189 files under `test/unit` | 58 files under `src/test` |
| Coverage | `vscode-test --coverage` → `text-summary, html, lcov, cobertura` | **none, anywhere** |
| Coverage gate | Codecov: **project 50 %, patch 70 %**, per-extension flags | none |
| Webview coverage | `nyc instrument ./dist/views --in-place`, collected from `window.__coverage__` during Playwright runs, merged with unit coverage | none |
| Machine-readable results | `mocha-multi-reporters` + `mocha-junit-reporter` → JUnit XML → `dorny/test-reporter` GitHub checks with badges | raw Mocha console output in the job log |
| Stack traces | `source-map-support` hook registered for every run, so failures point at the `.ts` | compiled `out/**/*.js` line numbers |
| UI/e2e | Playwright driving real VS Code + a real SQL Server in Docker | none (see [webview-ui-testing.md](webview-ui-testing.md)) |
| Test-tier config | multiple labeled `@vscode/test-cli` configs (unit, activation) | one unlabeled config |

Two of their choices are worth *not* copying. Their CI marks test steps `continue-on-error: true` and captures the exit code into an env var for reporting, so a failing test does not fail the build — this repo's plain `run:` steps are stricter and should stay that way. And their unit tier runs inside VS Code because their code is entangled with the API; this repo's mocked-`vscode` unit tier is *faster* and keeps 58 files runnable in seconds without downloading an editor. The gap worth closing is measurement and reporting, not the architecture.

## Current state in Firebird Studio

The three-tier setup is genuinely good, and one part of it is better than mssql's: **the e2e tier already runs a 12-job matrix** (Node 24/25/26 × Firebird 3/4/5/6-snapshot, with one job forced to WireCrypt-enabled). Nothing below is a criticism of test *quantity* — 83 test files across three tiers is substantial. What is missing is everything downstream of running them:

- **No coverage tooling exists.** `devDependencies` has no `nyc`, `c8`, or `istanbul` entry; no workflow computes or uploads coverage; nothing states what fraction of `src/` the 83 files actually reach. Several design docs carefully describe what *is* and *is not* covered — that knowledge is entirely manual, and nothing detects when a new file lands untested.
- **`@vscode/test-cli@0.0.12` is already installed and already supports coverage** — verified directly against the installed copy: `--coverage`, `--coverage-output`, `--coverage-reporter`, plus a config-level `coverage: { include, exclude, reporter, srcDir, all }` (V8-based, no instrumentation step). `.vscode-test.mjs` uses none of it; it is 9 lines with a single unlabeled config. **The suite tier can produce coverage today with a config change and zero new dependencies.**
- **CI reports nothing machine-readable.** `ci.yml` runs Mocha with the default `spec` reporter; a failure is only visible by opening the job log. No JUnit XML, no GitHub check annotations, no artifacts.
- **Everything is `ubuntu-latest`** — all three workflows, single OS. Yet a large amount of this codebase is platform-specific by nature: `executable-probe.ts` spawning `isql`/`gbak`/`docker`, `isql-terminal.ts` composing shell command lines, `gbak-options.ts` building argument lists with file paths, and the native-driver build path. The `isql -z` stdin hang (0.1.96) and the `gbak -z` non-zero-exit quirk (0.2.2) were both process-spawning bugs — exactly the class that behaves differently on Windows.
- **Workspace Trust is undeclared and untested.** `package.json` has no `capabilities.untrustedWorkspaces`, so VS Code disables the extension in Restricted Mode by default. That is arguably the right default for an extension that reads `.vscode/firebird.json` and spawns external binaries — but it is currently a default nobody chose, and no test asserts what happens in an untrusted folder. VS Code's own testing guidance recommends separate test configurations for trusted and untrusted states.
- **No Insiders run.** Every tier pins stable. With `engines.vscode` at `^1.101.0` against a 1.131 stable ([vscode-api-adoption.md](vscode-api-adoption.md)), a scheduled Insiders run is the cheapest possible early warning for a breaking platform change.

## Proposed feature

- **Measure coverage on both testable tiers.** The suite tier via `@vscode/test-cli`'s built-in `coverage` config; the unit tier via **`c8`** (Node's native V8 coverage — no `nyc`-style source instrumentation, so no build-step change and no risk of instrumented code leaking into a package). Emit `lcov` + `cobertura` + `text-summary` from both.
- **Upload both to Codecov under separate flags** (`unit`, `suite`) rather than merging locally — Codecov merges server-side, which avoids reproducing mssql's `mergeReports.js` + ReportGenerator + .NET-toolchain step for the same result.
- **Do not set a coverage gate in the first pass.** mssql's 50 %/70 % is *their* measured baseline, not a universal target; copying a number before measuring produces either a no-op gate or an instantly-red build. Measure first, then set the project floor at roughly the measured value and a patch target above it, so the gate ratchets rather than blocks.
- **JUnit XML + a GitHub check.** `mocha-multi-reporters` + `mocha-junit-reporter` (exactly mssql's pair) and `dorny/test-reporter`, so a failing test shows up as an annotated check with the failing test name, not a line to find in a log. Worth adopting mssql's `source-map-support` hook at the same time if the test tsconfigs emit sourcemaps, so the annotation points at the `.ts`.
- **A platform matrix for the tiers that can afford one.** The unit tier is fast and has no external dependencies — run it on `ubuntu-latest`, `windows-latest`, and `macos-latest`. The suite tier needs a Firebird server, so Windows/macOS coverage there is a bigger lift; the cheaper first step is to run the *unit* tier cross-platform, since the process-spawning and path-handling logic that differs by platform is all unit-testable.
- **A scheduled Insiders run** of the suite tier (mssql's `version: "insiders"`), on a nightly cron rather than per PR, reported separately so an upstream breakage does not block merges.
- **Decide and test Workspace Trust.** Declare `capabilities.untrustedWorkspaces` explicitly (almost certainly `supported: false` with a stated reason, given the external-process surface), and add a suite config that opens an untrusted folder to assert the extension degrades the way the declaration promises.

## Phase 1 — coverage measurement (done)

**The first measured baseline: 70.75 % of statements, 90.77 % of branches, 62.22 % of functions** (9 948/14 059 statements) across the **76 source files the unit tier loads**, from 1 438 passing tests. That denominator is the part that matters and is easy to misread, so it is stated here rather than left implicit — see "what the number does not cover" below.

- **Unit tier**: `c8` (added as the one new devDependency) wrapping the existing Mocha invocation, configured in `.c8rc.json`. V8 coverage, no instrumentation step, and nothing about how the tests run changes — `c8` propagates Mocha's exit code, so a failing test still fails the job. `npm run test:coverage` locally; CI's existing "Run unit tests" step became "Run unit tests with coverage".
- **Suite tier**: a `coverage` block in `.vscode-test.mjs`, using `@vscode/test-cli`'s own V8 coverage — **no new dependency, because it was already installed** (0.0.12 supports `--coverage`, `--coverage-output`, `--coverage-reporter` and a config-level `coverage` object; verified against the installed copy). It only activates with `--coverage`, so plain `npm run test:vscode-host` is unaffected; `npm run test:vscode-host:coverage` is the measured variant. **Not yet run end to end** — that tier needs a downloaded VS Code and a live Firebird server, so only the configuration is verified (via `vscode-test --list-configuration`), not the resulting number.
- Both tiers emit `text-summary` + `lcov` + `cobertura` into `coverage/unit` and `coverage/suite`. CI writes the summary into the job's GitHub Step Summary and uploads the report as a 14-day artifact.
- **No gate was set**, deliberately — see the note above about not copying mssql's thresholds. Phase 3 sets one from this baseline.

### What the number does not cover

**20 of the 96 non-test source files are outside the unit tier entirely** and are silently absent from the report rather than counted as 0 %. They are, without exception, the `vscode`-API-heavy modules the mocked-`vscode` tier was never meant to reach:

`extension.ts`, `firebirdTreeDataProvider.ts`, `result-view/index.ts`, `result-view/queryResultsView.ts`, `schema-designer/index.ts`, `profiler/index.ts`, `query-plan-view/index.ts`, `sql-notebook/{index,controller,serializer,export}.ts`, `copilot/{copilot-chat-participant,lm-tools,ai-query-actions}.ts`, `language-server/{index,db-words.provider}.ts`, `mcp-server/server.ts`, `container-provisioning/index.ts`, `mock-data/mock-data.ts`, `shared/connection-picker.ts`.

That absence is a property of the filter, not an oversight: coverage results are remapped through sourcemaps to `src/**/*.ts` (`excludeAfterRemap`), and a module no test ever `require`s has no V8 data to remap, so it drops out. `c8`'s `all: true` cannot fix it — it was tried and is a **no-op** under this configuration (identical output, 76 files either way), because pointing `all` at `out/` instead pulls the vendored webview JavaScript (jQuery, DataTables) and the esbuild bundle into the denominator, which inflated the figure to a meaningless 93.77 % over 102 904 statements. Clean filter, honest subset, documented gap — the right trade for a baseline.

**The suite tier is what covers most of those 20 files**, which is precisely why phase 1 wired it up even though its number cannot be produced in an environment without a Firebird server. A combined figure only becomes meaningful once both tiers report.

## Phase 2 — machine-readable results and source-mapped failures (done)

A failing test used to be a line to find in a job log. It is now an annotated GitHub check that names the failing test, with a stack trace pointing at the **TypeScript** source.

- **JUnit XML from every tier**, via mssql's own pairing (`mocha-multi-reporters` + `mocha-junit-reporter`). The plain-Mocha tiers (unit, e2e) pick it up from `.mocharc.json` + `mocha-reporters.json`, so the test commands themselves are unchanged; the extension-host tier gets an equivalent block in `.vscode-test.mjs` (it does not read `.mocharc.json` — its Mocha runs inside the Development Host), writing `test-reports/suite.xml` so a local run of both tiers doesn't have one overwrite the other. `spec` output is preserved everywhere — the XML is written alongside it, not instead of it.
- **`dorny/test-reporter@v3` check runs** for the unit tier (`ci.yml`) and the extension-host tier (`vscode-host.yml`), both with `checks: write` added to the job permissions. Two deliberate details: `fail-on-error: false`, because a pull request from a fork gets a read-only `GITHUB_TOKEN` and cannot create check runs — that must not fail an otherwise green build, since the test step itself is what gates; and the parser is `jest-junit` despite the name, which is the correct choice for `mocha-junit-reporter` output (both emit plain JUnit XML, and it is what mssql uses for the same reporter).
- **No check run for the e2e tier**, on purpose: it is a 12-entry matrix, and one check run per combination would bury the pull request's check list. That job uploads its XML as a per-combination artifact instead (the artifact *name* carries the Node/Firebird/WireCrypt combination — `upload-artifact` v4 rejects duplicate names across matrix jobs).
- Both plain-Mocha tiers share `test-reports/mocha.xml`, since both read the same `.mocharc.json`. That is harmless in CI, where each tier is its own job on its own runner; locally, running the e2e tier after the unit tier overwrites the file. Giving them separate names would mean either a second reporter-config file plus a CLI override in two places, or relying on how Mocha merges a config-file `reporter-option` array with a CLI one — not worth it for a file that is regenerated on every run.
- **Source-mapped stack traces without a new dependency.** The doc originally proposed mssql's `source-map-support` hook; Node's built-in `--enable-source-maps` does the same job here, enabled through Mocha's `node-option` in `.mocharc.json`. **Verified rather than assumed** — a deliberately failing test was compiled and run, and both the console output and the `<failure>` body in the XML reported `at Context.<anonymous> (src/test/….test.ts:3:11)`: a repo-relative TypeScript path, not the compiled `out/**/*.js` one.

Known limitation, worth recording so it isn't rediscovered: the `file=` attribute `mocha-junit-reporter` writes on each `<testsuite>` is the absolute path of the compiled `out/**/*.js` file, so the check run's *inline annotations* cannot always bind to a source file in the repo. The failure message and its source-mapped stack are still shown in the check's summary, which is where the value is. Fixing the attribute would mean post-processing the XML — not worth it unless inline annotations turn out to matter.

## Suggested phases

1. ~~**Coverage, measurement only**: `coverage` in `.vscode-test.mjs`, `c8` for the unit tier, both reports uploaded to Codecov under flags, no gate.~~ — **done**, see above, except the Codecov upload: it needs a `CODECOV_TOKEN` repository secret that does not exist yet, so CI publishes the summary and an artifact instead. Adding the upload is a two-line change once the token is configured.
2. ~~**Reporting**: JUnit XML from all tiers + `dorny/test-reporter` checks; source-map registration if sourcemaps are available.~~ — **done**, see above; source mapping via Node's built-in `--enable-source-maps` rather than the `source-map-support` dependency the doc originally proposed.
3. **Coverage gate** set from phase 1's actual baseline, patch target above project target.
4. **Platform matrix** for the unit tier (Windows + macOS), which is where the `isql`/`gbak`/`docker` spawn and path logic finally gets exercised off Linux.
5. **Insiders + Workspace Trust**: a nightly Insiders suite run, and an explicit `untrustedWorkspaces` declaration with a test config that verifies it.

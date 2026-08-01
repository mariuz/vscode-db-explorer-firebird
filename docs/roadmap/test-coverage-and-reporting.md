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

## Phase 3 — the coverage gate (done)

CI now fails if unit-tier coverage drops below a floor. The floor is **the measured baseline rounded down to whole percentages**, not an aspiration:

| Metric | Measured | Threshold |
| --- | --- | --- |
| Statements | 70.75 % | **70** |
| Branches | 90.77 % | **90** |
| Functions | 62.22 % | **62** |
| Lines | 70.75 % | **70** |

That is a ratchet: roughly 0.2–0.8 points of headroom, enough that ordinary refactoring does not trip it, tight enough that deleting a test or landing a sizeable untested module does. **Raise the numbers when the real figure rises** — that is the mechanism by which this gate is supposed to become demanding, rather than by picking an ambitious number now and suppressing it later.

Implementation details worth knowing before changing any of it:

- **Thresholds live in `.c8rc.json` but are inert there.** The four keys (`statements`/`branches`/`functions`/`lines`) are read by `c8`, but `check-coverage` is deliberately *not* set in the config, so only a command that explicitly passes `--check-coverage` enforces them. This is what keeps `npm run test:coverage` and CI's summary step purely informational — one number, one place, enforcement confined to a single step that can fail.
- **Use `c8 report --check-coverage`, not `c8 check-coverage`.** The standalone `check-coverage` subcommand **silently passes** under this configuration — verified directly: `c8 check-coverage --statements 99` against a 70.75 % baseline exits 0 and prints nothing, while `c8 report --check-coverage --statements 99` correctly exits 1 with `ERROR: Coverage for statements (70.75%) does not meet global threshold (99%)`. Both the negative and positive cases were checked before wiring it up.
- **Specify all four thresholds.** Any metric left unset defaults to **90**, which is not a neutral default: passing only `--statements 70` also silently enforces `lines >= 90` and fails.
- **The gate reads the data the test step already wrote**; it does not re-run the tests. `npm run test:coverage:check` is the local equivalent (runs the tests, then checks).

Two limits of this gate, stated so nobody reads more into a green check than it means:

- **It is project-level, not patch-level.** `c8` has no notion of diff coverage, so a pull request that adds a large untested file passes as long as the *overall* percentage stays above the floor. Patch coverage is genuinely useful and is what mssql's Codecov `patch: 70 %` target provides — that remains blocked on a `CODECOV_TOKEN` repository secret, and is the reason the Codecov item stayed open in phase 1.
- **It measures the unit tier only**, so the 20 `vscode`-heavy files listed under phase 1 are outside it entirely. A change that only touches those files cannot move this number in either direction.
- **Phase 4's platform matrix will interact with this.** Some covered branches are platform-dependent (`process.platform` in the external-tool probes), so the same commit can legitimately produce slightly different coverage on Windows or macOS. When that matrix lands, either enforce the gate on the Linux job only or lower the floor to the minimum across platforms — decide it then, with real numbers, rather than guessing now.

## Phase 4 — the platform matrix (done)

The unit tier now runs on `ubuntu-latest`, `windows-latest`, and `macos-latest` (`fail-fast: false`, so one platform failing does not cancel the others — knowing *which* platforms differ requires every job to finish). Every step runs under `bash`, which the Windows runner provides as Git Bash: PowerShell cannot execute `./node_modules/.bin/<tool>` (extensionless shell scripts) and the coverage-summary step is a POSIX brace group, so a single shell keeps one command working everywhere.

**The premise of this item was partly wrong, and the correction matters more than the matrix.** This doc and the roadmap both claimed the platform-specific logic — `executable-probe.ts`, `isql-terminal.ts`, `gbak-options.ts` — was only exercised on Linux. It is not. Every one of those functions takes an **injected platform parameter** defaulting to `process.platform`:

```ts
export function gbakCandidates(platform: NodeJS.Platform = process.platform): string[]
export function isqlCandidates(platform: NodeJS.Platform = process.platform): string[]
export function dockerCandidates(platform: NodeJS.Platform = process.platform): string[]
export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string
```

and the tests pass `'win32'`/`'darwin'`/`'linux'` explicitly — 34 such call sites across `gbak-options.test.ts`, `docker-discovery.test.ts`, `isql-terminal.test.ts`, and `ssh-tunnel.test.ts`. Windows path candidates and Windows argument quoting have therefore been under test all along, from a Linux runner. That is good design, and it means this matrix is **not** the safety net the item implied.

What running on three platforms genuinely adds, which is narrower but real:

- **Actual process spawning.** `executable-probe.test.ts` and `docker-discovery.test.ts` spawn real Node processes rather than stubbing `child_process`. Windows spawn semantics differ in exactly the areas that have already produced two shipped bugs — the `isql -z` stdin hang (0.1.96) and `gbak -z`'s untrustworthy exit code (0.2.2) — and `probeExecutable`'s "always close stdin" rule is a `child_process` behavior, not a string-building one.
- **The default-argument branch.** Because tests inject a platform, `process.platform`'s own branch of those four functions has only ever run as `'linux'`. On these runners it finally runs as `'win32'` and `'darwin'`.
- **Real filesystem and line-ending behavior**: the streaming flat-file parser and `workspace-config.ts` touch real paths, and a Windows checkout can hand them CRLF where a Linux one does not.
- **`ssh-tunnel.test.ts` already contains a `process.platform === 'win32'` branch** (the Pageant fallback) that no CI run has ever taken.

**The coverage gate stays Linux-only** (`if: matrix.os == 'ubuntu-latest'`). This is the decision phase 3 deliberately deferred, now made with the above in hand: those four `process.platform` defaults mean each runner covers a slightly different branch set, so a single ratchet enforced everywhere would either drift or have to be pinned to the cross-platform minimum. One authoritative platform keeps the number deterministic; the other two still publish their coverage in the job summary, so a divergence is visible without being load-bearing.

Artifacts and check runs are named per platform (`unit-coverage-<os>`, `Unit tests (<os>)`) — `upload-artifact` v4 rejects duplicate names across matrix jobs, and a Windows-only failure deserves its own visible check rather than three check runs fighting over one name.

**Not verified by running.** The Windows and macOS jobs cannot be exercised from a Linux development environment; only the workflow's structure was checked. The first CI run is the verification, and it may well surface genuine pre-existing platform bugs — that is the item working as intended, not the matrix being broken.

## Suggested phases

1. ~~**Coverage, measurement only**: `coverage` in `.vscode-test.mjs`, `c8` for the unit tier, both reports uploaded to Codecov under flags, no gate.~~ — **done**, see above, except the Codecov upload: it needs a `CODECOV_TOKEN` repository secret that does not exist yet, so CI publishes the summary and an artifact instead. Adding the upload is a two-line change once the token is configured.
2. ~~**Reporting**: JUnit XML from all tiers + `dorny/test-reporter` checks; source-map registration if sourcemaps are available.~~ — **done**, see above; source mapping via Node's built-in `--enable-source-maps` rather than the `source-map-support` dependency the doc originally proposed.
3. ~~**Coverage gate** set from phase 1's actual baseline, patch target above project target.~~ — **done** for the project-level floor (see above). The *patch* target is not done and cannot be with `c8` alone: diff coverage needs Codecov, which needs the `CODECOV_TOKEN` secret.
4. ~~**Platform matrix** for the unit tier (Windows + macOS), which is where the `isql`/`gbak`/`docker` spawn and path logic finally gets exercised off Linux.~~ — **done**, though the stated rationale turned out to be wrong: that logic takes an injected platform parameter and was already tested for Windows from Linux. See phase 4 above for what the matrix actually buys.
5. **Insiders + Workspace Trust**: a nightly Insiders suite run, and an explicit `untrustedWorkspaces` declaration with a test config that verifies it.

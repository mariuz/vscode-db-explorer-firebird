# Contributing to Firebird Studio for VS Code

Thank you for your interest in contributing! This guide explains how to set up your development environment, coding conventions, and the process for submitting changes.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Fork and Clone](#fork-and-clone)
  - [Install Dependencies](#install-dependencies)
  - [Build and Run](#build-and-run)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
  - [Making Changes](#making-changes)
  - [Coding Style](#coding-style)
  - [Commit Messages](#commit-messages)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

---

## Code of Conduct

Please be respectful and considerate in all interactions. We follow the standard open-source community norms: be welcoming, constructive, and professional.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 16 or later
- [npm](https://www.npmjs.com/) 8 or later
- [Visual Studio Code](https://code.visualstudio.com/) 1.32 or later
- [Git](https://git-scm.com/)
- A running [Firebird](https://firebirdsql.org/) instance (optional, for integration testing)

### Fork and Clone

1. Fork the repository on GitHub.
2. Clone your fork locally:

   ```bash
   git clone https://github.com/<your-username>/vscode-firebird-studio.git
   cd vscode-firebird-studio
   ```

3. Add the upstream remote so you can pull in future changes:

   ```bash
   git remote add upstream https://github.com/mariuz/vscode-firebird-studio.git
   ```

> **Quick start with Dev Containers**: this repo ships a `.devcontainer/` config (Node.js + a real Firebird 5 server, pre-seeded) for [VS Code's Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers). Open the folder in VS Code and choose **Reopen in Container** — no local Firebird install needed, and it mirrors the same `firebirdsql/firebird:5` image the e2e CI workflow uses (the Extension Host Tests workflow instead installs a Firebird 6 snapshot build directly from a tar.gz, to test against the same in-development version this project verifies changes against locally). Skip straight to [Build and Run](#build-and-run) once it's up.

### Install Dependencies

```bash
npm install
```

### Build and Run

The project uses [esbuild](https://esbuild.github.io/) for fast bundling.

| Command | Description |
|---|---|
| `npm run compile` | Build the extension (output to `out/`) |
| `npm run watch` | Rebuild on every file change |
| `npm run tsc-compile` | Type-check with TypeScript |

#### Two TypeScripts are installed, on purpose

Type-checking and test compilation use **TypeScript 7**, the native (Go) compiler — roughly 10x
faster here (a full type-check of the extension went from ~4.2s to ~0.42s; compiling the unit-test
tier from ~4.8s to ~0.47s).

TypeScript 7 removed the JavaScript compiler API, and **no released version of
`@typescript-eslint` supports it** — the latest (8.65.0) still declares `typescript ">=4.8.4
<6.1.0"`, and with TS 7 as the only TypeScript installed, ESLint fails to load its plugin at all.
So `typescript@6` stays installed for ESLint (and for whatever your editor uses), and TypeScript 7
is installed alongside under the `typescript7` alias:

```jsonc
"typescript":  "^6.0.3",               // @typescript-eslint + editor tooling
"typescript7": "npm:typescript@^7.0.2" // type-checking and test compilation
```

**This means `npx tsc` is *not* the compiler the build uses.** `node_modules/.bin/tsc` belongs to
`typescript@6`; every npm script and CI workflow calls TypeScript 7 by explicit path
(`node node_modules/typescript7/bin/tsc`). Use `npm run tsc-compile` rather than a bare `tsc`, or
you'll be type-checking with the older compiler.

Once `@typescript-eslint` ships TypeScript 7 support, this collapses back to a single dependency:
drop the `typescript7` alias, move `typescript` to `^7`, and change the scripts/workflows back to
plain `tsc`.

To run the extension inside a VS Code Extension Development Host:

1. Open the repository folder in VS Code.
2. Press `F5` (or **Run → Start Debugging**).
3. A new VS Code window opens with the extension loaded.

---

## Project Structure

```
vscode-firebird-studio/
├── docs/                      # Tutorials and guides
├── images/                    # Screenshots and banner images
├── resources/                 # Icons and SVG assets
├── snippets/                  # Firebird SQL code snippets
│   └── firebird.code-snippets
├── src/
│   ├── config/                # Configuration helpers
│   ├── interfaces/            # TypeScript interfaces and types
│   ├── language-server/       # IntelliSense / code completion
│   │   ├── completionProvider.ts
│   │   └── firebird-reserved.ts
│   ├── logger/                # Logging utilities
│   ├── mock-data/             # Mockaroo integration
│   ├── nodes/                 # Tree view nodes
│   ├── result-view/           # Query results webview
│   ├── shared/                # Shared utilities
│   ├── extension.ts           # Extension entry point
│   └── firebirdTreeDataProvider.ts
├── CHANGELOG.md
├── CONTRIBUTING.md            # This file
├── LICENSE
├── package.json
├── README.md
├── ROADMAP.md
└── tsconfig.json
```

---

## Development Workflow

### Making Changes

1. Create a feature branch from `master`:

   ```bash
   git checkout -b feature/my-feature
   ```

2. Make your changes, keeping commits small and focused.
3. Build and verify locally (`npm run compile`, then `F5` in VS Code).
4. Push your branch and open a Pull Request.

### Coding Style

- **TypeScript** is used throughout. Avoid `any` where possible — prefer explicit types.
- Formatting is enforced by **ESLint** (`.eslintrc.js`). Run the linter before committing:

  ```bash
  npx eslint src --ext .ts
  ```

- Prefer `const` over `let`; avoid `var`.
- Use `async/await` rather than raw `Promise` chains.
- Keep functions small and focused on a single responsibility.

### Commit Messages

Use the conventional commit format:

```
<type>(<scope>): <short summary>

[optional body]
[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

**Examples:**

```
feat(completion): add context-aware JOIN completion
fix(tree): prevent crash when database is unreachable
docs(readme): add connection setup screenshot
chore(deps): upgrade esbuild to 0.19
```

---

## Testing

There are three independent test tiers (see `CLAUDE.md` for how they differ):

```bash
npm run test              # unit tests — plain Mocha, mocked `vscode`, no VS Code needed
npm run test:e2e          # against a real Firebird server (configured via FIREBIRD_* env vars)
npm run test:vscode-host  # inside a real Extension Development Host
npm run test:vsix         # packages a .vsix, installs it, and smoke-tests the installed copy
npm run test:playwright   # drives a real VS Code window and its webviews (Playwright)
```

`npm run test:playwright` is the only tier that renders anything: it launches a real VS Code, and its results-grid spec needs a reachable Firebird server (`FIREBIRD_*`, same variables as the other database-backed tiers) — without one, that spec skips and the workbench specs still run. It runs nightly in CI, not on pull requests. Note for local runs: create any scratch database *through* the server (`CREATE DATABASE 'localhost/3050:/path/x.fdb'`), not with a local `isql`, or the server will not have permission to open the file.

`npm run test:vsix` is the only tier that exercises the **packaged** extension — the other three run from source, so none of them can see a `.vscodeignore` mistake or a bundle that never got built. It needs no Firebird server. If it fails it leaves its scratch directory on disk; the unpacked extension folder in there shows exactly what was packaged.

When adding new features, check whether existing tests cover the affected code paths and add tests if they don't. A new file under test must also be added to `tsconfig.test.json`'s `include` list, or the unit tier will not compile it.

Every tier writes JUnit XML into `test-reports/` alongside its normal console output (configured in `.mocharc.json`/`mocha-reporters.json`, and in `.vscode-test.mjs` for the extension-host tier). CI turns that into an annotated check run naming any failing test. Stack traces point at the `.ts` sources rather than compiled `out/` JavaScript, via Node's `--enable-source-maps`.

### Coverage

```bash
npm run test:coverage              # unit tier, via c8 -> coverage/unit/
npm run test:coverage:check        # the same, then enforce the thresholds CI enforces
npm run test:vscode-host:coverage  # suite tier, via @vscode/test-cli -> coverage/suite/
npm run test:playwright:coverage   # Playwright tier *and* the webviews -> coverage/combined/
```

The first two use V8 coverage remapped to the TypeScript sources, so neither needs an instrumentation build step, and both emit `text-summary`, `lcov`, and `cobertura`. CI runs the unit tier's coverage on every push, prints the summary in the job summary, and uploads the report as an artifact.

**CI fails if unit-tier coverage drops below the thresholds in `.c8rc.json`** (currently 70 % statements/lines, 90 % branches, 62 % functions). Those are the measured baseline rounded down, so they ratchet: if your change raises the real figure meaningfully, raise the thresholds with it. Run `npm run test:coverage:check` before pushing to see what CI will see.

**Webview coverage is different, and is the only place instrumentation is used.** c8 reads V8's counters from the Node process, and a webview runs in an Electron renderer iframe the extension host cannot see — so `npm run test:playwright:coverage` rewrites `src/**/htmlContent/js/*.js` with istanbul's instrumenter, runs the specs, reads the counters back out of each webview frame, **restores the files**, and merges the result with `coverage/unit/` *and* with `npm run test:coverage:webviews` (an ungated c8 run over the same files, which is where the unit tier's own coverage of them shows up — five of the eight are loaded directly by `src/test/webview-harness.ts`). The restore runs in a `finally`, so an interrupted run still leaves the tree clean; if you ever see a `.orig-for-coverage` file, a run was killed and the file beside it is instrumented source — run `node scripts/instrument-webviews.mjs restore`. There is no threshold on this report: it exists to show which webviews any test has ever executed, and it prints that list per file. One file is still at 0 % — `mock-data/htmlContent/js/app.js`, whose panel cannot open without a Mockaroo API key.

One caveat worth knowing before reading a percentage: the unit tier's report only includes files some test actually loads, so the `vscode`-API-heavy modules that tier deliberately does not reach (`extension.ts`, the tree provider, the webview hosts, the notebook, the Copilot integration) are *absent* from it rather than counted as 0 %. Those are the suite tier's job. See [`docs/roadmap/test-coverage-and-reporting.md`](docs/roadmap/test-coverage-and-reporting.md) for the full list and why `c8`'s `all` option cannot close the gap.

---

## Releasing

Releases are cut by pushing a tag; `.github/workflows/release.yml` does the rest.

```bash
# 1. Move the CHANGELOG's "Unreleased" entries under a new heading, e.g. "## 0.2.3 - 2026-08-02".
# 2. Bump the version in package.json to match.
# 3. Commit both, then:
git tag v0.2.3 && git push origin v0.2.3
```

The workflow refuses to release when the tag and `package.json` disagree, or when `CHANGELOG.md`
has no section for that version — a release whose notes are empty is worse than one that did not
happen, and the notes are read at exactly one moment. It then runs the unit gate, packages the
`.vsix`, installs *that exact artifact* into a real VS Code and smoke-tests it, attaches it to a
GitHub Release, and publishes to both registries.

**Publishing is skipped when a token is missing, and says so** (a `::warning::` in the job log, so
a half-published release cannot look like a complete one). Two repository secrets enable it:

| Secret | Where it comes from |
| --- | --- |
| `VSCE_PAT` | An Azure DevOps personal access token with the Marketplace **Manage** scope, for publisher `AdrianMariusPopa`. |
| `OVSX_TOKEN` | <https://open-vsx.org/user-settings/tokens>. Before the first publish only, run `npx ovsx create-namespace AdrianMariusPopa -p <token>` once. |

Run the workflow manually from the Actions tab to rehearse it: the manual trigger defaults to a dry
run, which packages, verifies and uploads the `.vsix` as a build artifact without publishing
anything or creating a release.

## Submitting a Pull Request

1. Ensure your branch is up to date with upstream `master`:

   ```bash
   git fetch upstream
   git rebase upstream/master
   ```

2. Push to your fork and open a PR against `mariuz/vscode-firebird-studio:master`.
3. Fill in the PR template (what changed and why).
4. A maintainer will review your PR. Please respond to feedback promptly.

**PR checklist:**

- [ ] `npm run compile` succeeds with no new errors.
- [ ] ESLint passes (`npx eslint src --ext .ts`).
- [ ] New or changed behaviour is covered by tests (where applicable).
- [ ] `CHANGELOG.md` has an entry for user-facing changes.
- [ ] Documentation in `README.md` or `docs/` is updated if needed.

---

## Reporting Bugs

Use the [GitHub Issue Tracker](https://github.com/mariuz/vscode-firebird-studio/issues) and choose the **Bug report** template. Please include:

- OS and VS Code version
- Firebird server version
- Steps to reproduce
- Expected vs actual behaviour
- Extension logs (open via **Firebird: Show Extension Logs** from the Command Palette)

---

## Requesting Features

Open an issue using the **Feature request** template. Check the [ROADMAP.md](ROADMAP.md) first to see if the feature is already planned.

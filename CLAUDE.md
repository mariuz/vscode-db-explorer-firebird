# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Firebird Studio is a VS Code extension (publisher `AdrianMariusPopa`) for exploring, querying, and managing Firebird&reg; databases from inside VS Code: a connection tree explorer, SQL editing (completion, snippets, linting, formatting), a query results webview, mock data generation, schema diffing, and an optional `@firebird` Copilot Chat participant.

## Commands

```bash
npm install                          # install dependencies
npm run compile                      # bundle extension with esbuild -> out/extension.js
npm run watch                        # esbuild in watch mode
npm run tsc-compile                  # tsc type-check only (doesn't gate builds; esbuild does the real build)

npx eslint src --ext .ts             # lint

npm run test                         # unit tests (mocked vscode module, no VS Code needed)
npm run test:e2e                     # e2e tests against a real Firebird server
npm run test:vscode-host             # suite tests inside a real VS Code Extension Development Host
```

To run a single unit test file directly (faster iteration than the full `npm run test`):

```bash
node node_modules/typescript7/bin/tsc -p tsconfig.test.json --noEmitOnError false
./node_modules/.bin/mocha --require ./out/test/setup.js out/test/sql-formatter.test.js
```

**Two TypeScripts are installed deliberately — don't "fix" this by consolidating.** Type-checking
and test compilation use TypeScript 7 (the native compiler, ~10x faster) via the `typescript7`
alias, invoked by explicit path. `typescript@6` remains the root `typescript` because TS 7 removed
the JavaScript compiler API and no released `@typescript-eslint` supports it (8.65.0 still peers on
`typescript <6.1.0`), so ESLint would not load at all otherwise. Consequence worth remembering: a
bare `tsc`/`npx tsc` resolves to **6**, not the compiler the build uses — always go through the npm
scripts or the explicit path. See CONTRIBUTING.md for how to collapse this back to one dependency
once typescript-eslint catches up.

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded for manual testing.

## Three-tier test setup

There are three independent test configs/suites — don't mix them up:

1. **Unit tests** (`src/test/*.test.ts`, excludes `e2e/` and `suite/`) — compiled via `tsconfig.test.json`, run with plain Mocha. They run outside VS Code entirely: `src/test/setup.ts` patches `Module._load` so that `require('vscode')` resolves to the hand-written stub at `src/test/mocks/vscode.ts` instead of the real API. When code under test calls a `vscode` API that isn't stubbed yet, add it to that mock rather than pulling in the real module. `tsconfig.test.json`'s `include` list enumerates exactly which `src/` files are compiled for this suite — new files under test must be added there.
2. **E2E tests** (`src/test/e2e/*.test.ts`, `tsconfig.e2e.json`) — connect to a real Firebird server via `node-firebird` directly (no VS Code, no extension code). Configured entirely through env vars: `FIREBIRD_HOST`, `FIREBIRD_PORT`, `FIREBIRD_DATABASE`, `FIREBIRD_USER`, `FIREBIRD_PASSWORD` (see `src/test/e2e/firebird-connection.test.ts` for defaults). `scripts/seed-test-db.js` creates and seeds the schema these tests expect; the GitHub Actions e2e workflow runs it before the suite.
3. **VS Code host suite** (`src/test/suite/*.test.ts`, `tsconfig.suite.json`) — runs inside a real Extension Development Host via `@vscode/test-cli` (`.vscode-test.mjs`). Verifies actual activation and command registration (`extension.test.ts` looks up the extension by id `AdrianMariusPopa.vscode-firebird-studio` — keep this in sync with `package.json`'s `publisher.name`). The Copilot Chat participant is registered conditionally (`typeof vscode.chat !== 'undefined'`) specifically so this suite's activation test doesn't depend on `github.copilot-chat` being installed.

CI (`.github/workflows/ci.yml`) only runs the unit-test tier; e2e and vscode-host each have their own workflow.

## Architecture

**Entry point**: `src/extension.ts#activate()` wires everything together — it builds each provider/service, pushes it onto `context.subscriptions`, and registers every `firebird.*` command. This is the map to read first when tracing how a UI action reaches the database.

**Driver abstraction** (`src/shared/driver.ts`): all SQL execution goes through the static `Driver` class, which delegates to one of two interchangeable `ClientI` implementations selected by the `firebird.useNativeDriver` setting:
- `NodeClient` wraps the pure-JS `node-firebird` package (default; no native compilation needed).
- `NativeClient` wraps `node-firebird-driver-native` / `node-firebird-native-api` (required for WireCrypt support). If its native binary isn't built yet, it triggers the `firebird.buildNative` command, which shells out to `npm run install-native` (a node-gyp build).

`Driver.runBatch()` splits multi-statement SQL via `sql-splitter.ts` and executes each statement independently, returning one `BatchResult` per statement (used by both `firebird.runQuery` and bookmark/history re-run commands). `Driver.getQueryPlan()` uses the native driver's real `EXPLAIN PLAN` API when available, and falls back to a heuristic index-metadata query built from `extractTableNames()` when using the pure-JS driver.

**Connection/credential state**:
- `Global` (`src/shared/global.ts`) holds the single in-memory `activeConnection` and drives the status bar item.
- Saved connections (host/port/db/user, *not* password) live in `context.globalState` keyed by `Constants.ConectionsKey`.
- Passwords never touch `globalState` — they're stored/retrieved through `CredentialStore` (`src/shared/credential-store.ts`), a thin wrapper over VS Code's `SecretStorage`, keyed by `firebird.password.<connectionId>`. Anywhere a `ConnectionOptions` is read back from `globalState`, its password must be re-resolved via `CredentialStore.getPassword()`/`Driver`'s internal `resolvePassword()` before use.

**Tree explorer** (`src/firebirdTreeDataProvider.ts` + `src/nodes/`): implements VS Code's `TreeDataProvider<FirebirdTree>`. `FirebirdTree` (in `src/interfaces`) is the common node interface — each node type (`NodeHost` → `NodeDatabase` → category folders → `NodeTable`/`NodeView`/`NodeProcedure`/`NodeTrigger`/`NodeGenerator`/`NodeDomain` → `NodeField`) implements `getTreeItem()`/`getChildren()` and lazily queries Firebird system tables (via `Driver.client` directly) to populate its children on expand. Node classes also own the SQL-building logic for their own actions (e.g. `NodeTable.dropTable()`, `.selectAllRecords()`), sourced from canned queries in `src/shared/queries.ts`.

**Other feature modules**, each self-contained and wired up in `extension.ts`:
- `src/language-server/` — completion, hover, document-symbol, definition and formatting providers (`completionProvider.ts`, `db-words.provider.ts`, `firebird-reserved.ts`, `formattingProvider.ts`). `KeywordsDb` (`db-words.provider.ts`) builds the schema both completion and hover use and caches it for `SCHEMA_CACHE_TTL_MS`, keyed by connection id + default schema + the completion settings; it is the single place that talks to the database for language features, and it must `detach()` every connection it opens.
- `src/shared/sql-linter.ts`, `sql-formatter.ts`, `sql-splitter.ts` — SQL diagnostics, formatting, and statement splitting; pure functions, easiest place to add SQL-parsing logic and unit-test it in isolation.
- `src/result-view/` — webview that renders query results (pagination, sort/filter, export to JSON/CSV/XLSX/PDF).
- `src/schema-designer/` — visual multi-table Schema Designer webview (`schema-graph.ts` assembles the whole-database ER graph from `getSchemaColumnsQuery()`/`getForeignKeysQuery()`; the webview lets you view/add/alter tables, columns, and foreign keys, then diffs the in-memory draft against the loaded schema to generate `CREATE`/`ALTER TABLE` DDL). Backs the `firebird.schemaVisualizer.open`, `firebird.table.createTable`, and `firebird.table.alterTable` commands — same webview, different initial focus.
- `src/mock-data/` — Mockaroo API integration for generating mock rows.
- `src/schema-diff/` — fetches schema snapshots from two saved connections and renders a text diff report.
- `src/bookmarks/`, `src/query-history/` — separate `TreeDataProvider`s persisted in `context.globalState`, for saved queries and session run history respectively.
- `src/copilot/` — the `@firebird` Copilot Chat participant (`/query`, `/optimize`, `/explain` slash commands); `schema-context.ts` serializes the current DB schema into the system prompt. Only registered when `vscode.chat` exists at runtime (see test-tier note above) — the extension has no hard `extensionDependencies` on Copilot Chat. `lm-tools.ts` additionally registers five `vscode.lm.registerTool` language model tools (agent mode / `#firebird*` references), guarded the same way on `vscode.lm.registerTool`.
- `src/shared/executable-probe.ts` — the single spawn-based probe behind every "is this external binary present?" check (`probeIsql`/`probeGbak`/`probeDocker`, feeding `resolveIsqlExecutable()`/`resolveGbakExecutable()`/`resolveDockerExecutable()`). It **always closes stdin** and can require an identifying banner; both rules exist because of real bugs (`isql -z` reads stdin and hung the probe until it timed out, reporting a working isql as missing; `gbak -z` prints its banner and *then* exits non-zero, so its exit code can't be trusted). Add new external-tool probes here rather than hand-rolling `cp.execFile` at the call site.
- `src/shared/db-tools.ts` — the five database tool bodies (`list_connections`, `get_schema`, `run_query`, `get_query_plan`, `run_write_query`) shared by *both* AI transports, behind a small `ToolExecutor` interface (`listConnections`/`withConnection`/optional `audit`). The MCP subprocess and `copilot/lm-tools.ts` each supply their own executor; the tool behavior — what statements are refused, what the write gate checks, how results are shaped, what the model is told — lives here once. **Must never import `vscode`**: the MCP subprocess is a plain Node process. Add new tool logic here, not in either caller.
- `src/config/` — typed wrapper (`getOptions()`) over VS Code settings under the `firebird.*` namespace, with per-setting validation/fallback to `package.json`'s declared defaults. Re-read on every `onDidChangeConfiguration`.
- `src/logger/logger.ts` — central logger (output channel + optional user-facing notifications); respects the `firebird.logLevel` setting.

**Build**: esbuild bundles `src/extension.ts` to a single `out/extension.js` (CJS, Node platform), externalizing `vscode` and `node-firebird-native-api` (the latter has a native `.node` binary that can't be bundled). `npm run tsc-compile` is a separate, non-blocking type-check pass — it is *not* part of `compile`/`vscode:prepublish` and is known to have pre-existing errors.

## Coding conventions

- TypeScript throughout; prefer explicit types over `any` where practical (ESLint doesn't enforce this — `no-explicit-any` and `no-unused-vars` are disabled project-wide).
- `const` over `let`; no `var`.
- `async/await` over raw `Promise` chains.
- Conventional commits: `<type>(<scope>): <summary>` with types `feat|fix|docs|refactor|test|chore`.
- User-facing changes need a `CHANGELOG.md` entry.

# Roadmap

This document outlines the planned features and improvements for the **Firebird Studio for VS Code** extension, inspired by [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648).

## Enhanced Object Explorer

- [x] Expand tree view to include views, stored procedures, triggers, generators/sequences, domains, exceptions, and roles
- [x] Add schema visualization — right-click a database to see a visual diagram of tables, relationships, and objects
- [x] Show column types, constraints (primary key, foreign key, not null, unique) inline in the tree view
- [x] Display system tables and metadata tables with a toggle option

## Intelligent IntelliSense Improvements

- [x] Context-aware code completion that understands the current database schema in real time
- [x] Auto-complete for stored procedure and trigger names and parameters
- [x] Syntax highlighting improvements for Firebird-specific SQL dialect (PSQL blocks, `EXECUTE BLOCK`, etc.)
- [x] Snippet support for common Firebird DDL/DML patterns (e.g., `CREATE TABLE`, `CREATE PROCEDURE`, `CREATE TRIGGER`)

## AI-Powered Enhancements

- [x] GitHub Copilot integration for Firebird SQL — contextual AI suggestions tailored to the connected database
- [x] Natural-language query generation — describe what you want in plain English, get Firebird SQL
- [x] AI-assisted query optimization and explain plan analysis
- [x] AI-assisted schema design from sample data

## Query Execution and Results

- [x] Support for executing multiple queries in a single document (batch execution)
- [x] Session query history — automatically log and recall previously executed queries
- [x] Explain and analyze query performance with `SET PLANONLY ON` / `SET PLAN ON` integration
- [x] Editable result grids — update, insert, and delete rows directly from query results
- [x] Use isql/isql-fb in an integrated terminal, connected to the active database, and run `.sql` files through it directly
- [x] Enhanced export options — export results to CSV, JSON, Excel (XLSX), and PDF

## Connection Management

- [x] Support for Firebird embedded databases
- [x] Connection profiles with saved credentials (securely stored via VS Code Secret Storage API)
- [x] Connection pooling for improved performance on repeated queries
- [x] Support for Firebird 4.x and 5.x wire protocol and authentication (SRP, ChaCha encryption)
- [x] Docker container support — connect to Firebird instances running in Docker

## Database Management

- [x] Create, alter, and drop database objects directly from the UI (tables, views, stored procedures, triggers, generators, domains)
- [x] Visual table designer for creating and modifying tables
- [x] Index management — view, create, and drop indexes
- [x] User and role management — create and manage database users and roles
- [x] Database backup and restore integration (gbak/nbackup)
- [x] Database statistics and monitoring (connection/I-O monitoring via `MON$` tables)

## Collaboration and Productivity

- [x] SQL formatting and beautification
- [x] Diff support for comparing database schemas
- [x] SQL linting and error detection before execution
- [x] Bookmarks for frequently used queries
- [x] Workspace-level database configuration (`.vscode/firebird.json`)

## Documentation and Community

- [x] Improved extension documentation and wiki
- [x] Sample databases and tutorials for getting started
- [x] Contributing guide for community contributors

## Inspired by vscode-mssql

The following features are adapted from Microsoft's [vscode-mssql](https://github.com/microsoft/vscode-mssql) extension for SQL Server, reviewed for what's applicable to Firebird. Heavier, multi-phase features link out to a dedicated design doc under [`docs/roadmap/`](docs/roadmap/); lighter ones are listed directly.

### Visual design & schema tools

- [x] Visual multi-table Schema Designer — drag-and-drop ER modeling, auto-layout, and consolidated DDL generation, replacing/merging today's read-only schema visualizer and single-table designer ([design doc](docs/roadmap/visual-schema-designer.md))
- [x] Copilot-assisted schema editing inside the Schema Designer — natural-language edits applied to an open diagram, not just one-shot DDL generation (see design doc above)
- [x] Extend the Table Designer to alter existing tables, not just create new ones (see design doc above)
- [ ] ORM-based migrations from the Schema Designer — emit the designer's diff as a migration file for a JS/TS ORM (Prisma, TypeORM, Sequelize, Knex) instead of only raw DDL, mirroring mssql 1.43.0's "ORM-based migrations in Schema Designer" (speculative — validate demand first, and confirm which ORMs actually have usable Firebird support before picking one)

### Query execution & analysis

- [x] Graphical Query Plan Visualizer — interactive execution-plan diagram instead of today's plain-text `EXPLAIN PLAN` output ([design doc](docs/roadmap/query-plan-visualizer.md))
- [x] Live connection/query Profiler — polling `MON$*` dashboard with delta stats, replacing today's one-shot connection snapshot ([design doc](docs/roadmap/live-profiler.md))
- [x] Results grid: column freeze/show/hide, copy selection as an `INSERT` statement, copy selection as a SQL `IN (...)` clause
- [x] Configurable keyboard shortcuts for query/result actions (a `firebird.shortcuts` setting, mirroring `mssql.shortcuts`)
- [x] Per-session transaction isolation level, lock timeout, and other `SET`-option controls exposed as settings
- [x] AI analysis of query results in the results panel — reuse the existing `/explain`/`/optimize` chat-prompt-building pattern (`src/copilot/prompts.ts`) to summarize/explain a result set on request, mirroring mssql's own "future" roadmap item for Copilot-assisted result analysis
- [ ] Server-side result paging and query-level filtering — today every row of a result is fetched and posted to the webview (`selectAllRecordsQuery()` is a bare `SELECT * FROM t`, and `firebird.recordsPerPage` only sets DataTables' client-side page length), so sort/filter/page never reach the server and a large table has no ceiling at all; mssql 1.43.0's "query-level filtering for Edit Data across full result sets" is the same idea ([design doc](docs/roadmap/large-result-sets.md))

### Data import/export & integration

- [x] Flat File Import Wizard — guided CSV/TSV/JSON import into a new or existing table, with local type inference ([design doc](docs/roadmap/flat-file-import-wizard.md))
- [x] SQL Notebooks — native VS Code notebook editor for Firebird SQL with rich per-cell results ([design doc](docs/roadmap/sql-notebooks.md))
- [x] Data API Builder — generate REST/GraphQL endpoint configs from the connected schema, optionally Copilot-assisted (speculative — validate demand first) ([design doc](docs/roadmap/data-api-builder.md))

### Database lifecycle

- [x] Firebird Database Projects — schema-as-code project structure with extract/build/publish and generated migration scripts, built on the existing schema-diff engine ([design doc](docs/roadmap/database-projects.md))
- [x] Create, rename, and drop whole databases from the connection tree (not just objects within one)
- [x] Object Search — fuzzy search for any object (table/view/procedure/trigger/etc.) by name across a connection
- [x] Local Firebird container **creation** — provision a new Dockerized Firebird server from the extension, extending today's detect-existing-containers support
- [x] Connection dialog: color-coded connection groups, and paste a full connection string to prefill fields

### Onboarding & discoverability

- [x] Object Explorer Filters — a type-ahead filter box on the connection tree itself (narrows which nodes are shown as you type), distinct from the existing Object Search QuickPick which searches rather than filters the tree in place
- [x] Getting Started walkthrough — an interactive, checklist-style onboarding flow using VS Code's native `contributes.walkthroughs` API, complementing the existing static `docs/getting-started.md`
- [x] In-product "What's New" notification/webview shown once after an extension update, summarizing the new version's `CHANGELOG.md` entry
- [x] Firebird Dev Container template — a ready-made `.devcontainer` config (Firebird server + this extension preinstalled) for VS Code's Dev Containers extension, for quick-start/demo/CI-reproduction scenarios

## Inspired by vscode-pgsql

The following features are adapted from Microsoft's [PostgreSQL extension for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) (`ms-ossdata.vscode-pgsql`; see also its [overview docs](https://learn.microsoft.com/en-us/azure/postgresql/development/vs-code-extension/postgresql-extension-overview)), reviewed — including its demo GIFs, not just its written docs — for what's applicable to Firebird. Several of its features overlap with items already tracked above under "Inspired by vscode-mssql" (schema visualization, results export, connection groups, object search, container creation) and aren't repeated here; this section covers what's genuinely new.

### AI & agent integration

- [x] MCP Server — expose this extension's own connection/schema/query-execution tooling to *any* MCP-compatible AI client (Claude Desktop, Cursor, VS Code Copilot Agent mode), not just the `@firebird` chat participant, which only works inside this extension's own Copilot Chat integration ([design doc](docs/roadmap/mcp-server.md))
- [x] AI Query Actions in the editor — right-click selected SQL for Explain/Optimize (reusing the existing `/explain`/`/optimize` chat logic) without first opening the chat panel
- [x] AI-assisted DDL conversion from other databases — a `/migrate` chat participant command that takes pasted DDL from another RDBMS (MySQL, PostgreSQL, SQL Server, legacy InterBase) and asks Copilot for the Firebird-dialect equivalent, reusing the existing `src/copilot/prompts.ts` system-prompt/message-builder pattern rather than a new parsing engine — inspired by vscode-pgsql's AI-powered Oracle-to-PostgreSQL schema migration assistant

### Query execution & results

- [x] Chart visualization for query results — render numeric result columns as line/bar/pie/scatter charts directly in the results panel, alongside the existing grid view
- [x] Parameterized query execution — write a query with named/typed placeholders (e.g. `:paramName`) and fill in bound values (with a type) through a sequence of prompts before running, distinct from today's plain-text-only execution; rewrites named placeholders to `node-firebird`'s positional `?` binding, previously only used internally in one place (`Driver.getQueryPlan()`'s index-metadata fallback query) and, discovered while implementing this, silently dropped by the native driver client — both now fixed

### Object explorer

- [x] Generic "Script as Create" / "Script as Drop" — reverse-engineer any selected object's DDL from one tree action regardless of type, rather than only tables/procedures/views/triggers each having their own bespoke edit command
- [x] Object privileges/grants viewer — show a selected object's grants (`RDB$USER_PRIVILEGES`) in a simple read-only panel, complementing "Script as Create" (which covers DDL, not privileges)
- [ ] Deep refresh — refreshing a tree node re-reads all of its *expanded* descendants in place, so objects added or dropped elsewhere appear/disappear without collapsing the tree or reconnecting (pgsql 1.19.0's "Object Explorer refresh handling additions and deletions throughout subtrees"); today `refresh(element)` only fires the change event for that one node

### Connectivity

- [x] SSH tunneling — connect to a Firebird server reachable only through an SSH bastion/jump host, tunneling the wire-protocol connection through a local forwarded port ([design doc](docs/roadmap/ssh-tunneling.md))

## Firebird 6 support

Firebird 6.0 is the first Firebird release with SQL schemas, which changes the object model this extension is built on rather than adding a feature beside it. The CI already installs a Firebird 6 snapshot, so this is testable today.

- [ ] **SQL schemas** — a schema level in the Object Explorer, `RDB$SCHEMA_NAME` in every metadata query, schema-qualified DDL/scripting/row-editing, `SET SEARCH_PATH`-aware completion and a "New Query in Schema" action, and color-coded schemas in the Schema Designer. Every metadata query in `src/shared/queries.ts` is schema-blind today (`grep -rn 'RDB\$SCHEMA' src/` returns nothing at all), so on a Firebird 6 database with two same-named tables in different schemas the tree shows two indistinguishable nodes and every action on them resolves by search path — silently operating on the wrong object. All of it must be version-gated: `RDB$SCHEMA_NAME` is a hard SQL error on Firebird 3/4/5 ([design doc](docs/roadmap/firebird6-schemas.md))

## Editor language features

- [ ] **Hover, Go to Definition, and Document Symbols for `.sql` files** — `languages.registerCompletionItemProvider` is currently the *only* language provider registered in the entire codebase; there is no hover, no `F12`, and no Outline/breadcrumb for a SQL script. All three reuse machinery that already exists (`SchemaProvider`'s metadata cache, `sql-splitter.ts`'s statement boundaries, `script-as/ddl-builders.ts`'s DDL generation) ([design doc](docs/roadmap/sql-language-features.md))

## VS Code platform API adoption

`engines.vscode` is `^1.101.0` while VS Code stable is 1.131 — the extension runs fine, but the type floor hides ~13 months of API additions, several of which replace code written by hand here. Reviewed release by release; Marketplace-publishable work only (proposed APIs are tracked as a watch list in the design doc) ([design doc](docs/roadmap/vscode-api-adoption.md)).

- [ ] Raise `engines.vscode`/`@types/vscode` to `^1.110.0` — the floor that covers every finalized API below
- [ ] `context.secrets.keys()` (1.105) to reconcile stored passwords against saved connections and back a "Clear All Saved Passwords" command — `CredentialStore` can store, read, and delete a password but cannot enumerate them, so a secret orphaned by a failed delete stays in SecretStorage permanently and invisibly
- [ ] Ship the Firebird dialect rules already in `src/copilot/prompts.ts` as a `contributes.chatInstructions` file (1.105), so agent mode and inline chat write Firebird-correct SQL instead of only the `@firebird` participant — the missing half of the existing Language Model Tools work
- [ ] `ThemeIcon` webview/custom-editor tab icons (1.110) for the six webviews that currently share the default editor tab icon
- [ ] `QuickInputButton.toggle`/`.location` and `QuickPick.prompt`/`QuickPickItem.resourceUri` (1.108/1.109) in the Object Explorer filter, object search, and connection picker
- [ ] Contribute the view container to the `secondarySidebar` (1.106), so the connection tree can sit opposite the editor with results in the panel

## Distribution

- [ ] Publish to the [Open VSX Registry](https://open-vsx.org/) alongside the VS Marketplace, so the extension installs in Cursor, VSCodium, and other non-Microsoft builds — vscode-pgsql ships exactly this (a Cursor build on Open VSX), and this extension's own MCP server already names Cursor as a target client while being uninstallable there. There is no release/publish workflow in `.github/workflows/` at all today (only `ci`, `e2e`, and `vscode-host`), so this is a packaging/release-automation item as much as a registry one

## Testing and CI

- [x] E2E test matrix covering Firebird 3, 4, 5, and 6 (snapshot) across Node.js 24-26, mirroring [node-firebird's own CI](https://github.com/mariuz/node-firebird/blob/master/.github/workflows/node.js.yml) so driver-compatibility regressions surface before they reach users on older or newer servers

Reviewed against [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s actual test pipeline — `codecov.yml`, `playwright.config.ts`, `.vscode-test.mjs`, and `build-and-test.yml`, not its documentation. (vscode-pgsql's public repository contains only a README, changelog, and images — no source, no tests, nothing to compare against.) Two design docs: [test-coverage-and-reporting.md](docs/roadmap/test-coverage-and-reporting.md) and [webview-ui-testing.md](docs/roadmap/webview-ui-testing.md).

- [x] **Measure test coverage** — `c8` for the unit tier and `@vscode/test-cli`'s own built-in coverage for the suite tier (no new dependency there; 0.0.12 already supported it). First measured baseline: **70.75 % of statements, 90.77 % of branches, 62.22 % of functions** across the 76 source files the unit tier loads, from 1 438 tests. Deliberately no threshold yet — mssql's 50 %/70 % Codecov gates are their measured baseline, not a target to copy. The 20 `vscode`-API-heavy files outside the unit tier are enumerated in the design doc
- [x] **Machine-readable test results** — JUnit XML from all three tiers via `mocha-multi-reporters` + `mocha-junit-reporter` (mssql's exact pair), surfaced as annotated `dorny/test-reporter` check runs for the unit and extension-host tiers, so a failure names the failing test instead of hiding in a job log. Failure stacks point at the TypeScript sources via Node's built-in `--enable-source-maps`, no `source-map-support` dependency needed. The 12-job e2e matrix uploads XML artifacts instead of creating twelve check runs
- [ ] **Cross-platform unit-test matrix** (Windows + macOS alongside Linux) — every workflow is `ubuntu-latest` today, yet the process-spawning and path-handling code is where the platform differences live: `executable-probe.ts`, `isql-terminal.ts`, `gbak-options.ts`. Both external-tool bugs fixed in 0.1.96 and 0.2.2 were of exactly this class, and the unit tier is fast enough to fan out
- [ ] **VSIX packaging + install smoke test** — all three tiers run from source via `extensionDevelopmentPath`, so nothing ever exercises the *packaged* extension; a `.vscodeignore` mistake, a missing bundled asset, or a broken esbuild external ships silently across three separate bundle outputs. Package with `vsce`, install into the test VS Code, activate, run a command (mssql's `vsix.spec.ts`) — also a prerequisite for the Open VSX item above
- [ ] **Real-browser webview tests (Playwright)** — the six webviews are verified today only by loading their `app.js` under `src/test/webview-harness.ts`, a Proxy-based stub whose own header states it is "intentionally not a real DOM" and excludes anything needing real layout (the Schema Designer's `render()`/`measureAll()` specifically). No test has ever confirmed that any webview *renders*. Nightly rather than per-PR, given how fragile mssql's own equivalent tier is configured to be (`workers: 1`, `retries: 2`, video-on-failure)
- [ ] **Nightly VS Code Insiders run** of the extension-host suite — every tier pins stable today, and with `engines.vscode` well behind current stable this is the cheapest early warning for an upstream breaking change
- [ ] **Declare and test Workspace Trust** — `package.json` declares no `capabilities.untrustedWorkspaces`, so VS Code silently disables the extension in Restricted Mode. That is probably the right answer for an extension that reads `.vscode/firebird.json` and spawns `isql`/`gbak`/`docker`, but it is currently a default nobody chose and no test asserts; VS Code's testing guidance recommends separate trusted/untrusted test configurations

---

> **Note**: This roadmap is subject to change based on community feedback and contributions. Feature requests and suggestions are welcome via [GitHub Issues](https://github.com/mariuz/vscode-firebird-studio/issues).
>
> Inspired by the features announced in [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648), by [Microsoft's vscode-mssql extension](https://github.com/microsoft/vscode-mssql) for SQL Server, and by [Microsoft's vscode-pgsql extension](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) for PostgreSQL.
>
> **Upstream review cutoffs** (2026-08-01): vscode-mssql through **1.44.1**, vscode-pgsql through **1.28.0** (plus its published feature documentation, not only its changelog), and the VS Code extension API through **1.131**. Both extensions' changelogs were last reviewed on 2026-07-31 and have shipped nothing new since, so the items added in this round come from reviewing their documented feature surface and the VS Code platform rather than their release notes. The testing items were reviewed separately against vscode-mssql's test configuration and CI workflows in source; vscode-pgsql publishes no source or tests, so it could not be reviewed for testing practice at all.

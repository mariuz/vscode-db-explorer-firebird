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
- [ ] Server-side result paging and query-level filtering — mssql 1.43.0's "query-level filtering for Edit Data across full result sets" is the same idea. **Phase 1 done**: a `firebird.maxResultRows` setting (default 10 000, 0 = unlimited) makes "Select All Records" emit `SELECT FIRST n *` — a real server-side cap, verified against a live server — and trims any larger result before it reaches the webview, with the grid stating what it dropped and naming the setting. Note the asymmetry: for arbitrary user SQL the pure-JS driver returns the whole result set in one callback, so the cap bounds the webview payload but not the fetch. Phases 2–3 (paging via `FIRST/SKIP`, filter/sort push-down) remain ([design doc](docs/roadmap/large-result-sets.md))

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
- [x] Deep refresh — **checked the premise first, and the deep part was already true.** VS Code's own `TreeDataProvider` docs state that firing `onDidChangeTreeData` "will trigger the view to update the changed element/root and its children **recursively (if shown)**", and this extension's nodes cache nothing — every `getChildren()` re-queries — so a refresh has always re-read every expanded descendant, additions and deletions included. What was genuinely missing was pgsql's "refresh *any* node": Refresh existed only in the view title, which re-queries every expanded node across every connection. It is now also an inline action on hosts, databases and category folders, so one subtree can be re-read on its own. `firebird.explorer.refresh` already accepted a node argument and passed it to `refresh(node)` — the plumbing existed and nothing ever supplied one

### Connectivity

- [x] SSH tunneling — connect to a Firebird server reachable only through an SSH bastion/jump host, tunneling the wire-protocol connection through a local forwarded port ([design doc](docs/roadmap/ssh-tunneling.md))

## Firebird 6 support

Firebird 6.0 is the first Firebird release with SQL schemas, which changes the object model this extension is built on rather than adding a feature beside it. The CI already installs a Firebird 6 snapshot, so this is testable today.

- [ ] **SQL schemas** — a schema level in the Object Explorer, `RDB$SCHEMA_NAME` in every metadata query, schema-qualified DDL/scripting/row-editing, `SET SEARCH_PATH`-aware completion and a "New Query in Schema" action, and color-coded schemas in the Schema Designer. **Phases 1a–1c done**: engine-version detection (cached per connection), schema-aware **Tables and Views** with qualified labels and SQL, schema-filtered column metadata and view sources, and a two-part-aware identifier guard so row editing works on a qualified table — all verified against a live Firebird 6.0.0 server with deliberate `SALES`/`PUBLIC` collisions, where the old code demonstrably queried the wrong table and listed merged columns belonging to no real object. **The read path is now complete for every schema-scoped category** — tables, views, procedures (including parameters and body), triggers, generators, domains and exceptions. Roles need no change: `RDB$ROLES` has no schema column, since roles are database-wide. Foreign keys and generated `CREATE TABLE` DDL are schema-correct too — the FK catalogue query returned an 8-row cross product for two foreign keys before all four of its joins were schema-scoped. The Schema Designer's ER diagram is correct too — it previously merged same-named tables into one box and duplicated every column, because four separate catalogue joins matched names that repeat per schema. The agent-facing `get_schema` (shared by the MCP server and the Copilot language-model tools) is schema-aware too — the worst place for a merged table, since an agent acts on it without noticing. Diagram labels drop a redundant `PUBLIC.` prefix while the graph keeps a qualified identity for DDL. The Data API Builder is schema-aware too — it previously published a route repeating the same primary-key parameter eight times, for a merged table that does not exist. The write path (phase 2) audited out as largely already done — qualification lives in the names themselves, so Select All Records, drops, Script as Create, row editing and the designers' generated DDL are all schema-correct, now pinned by tests. Schema-diff is schema-aware too — its snapshots previously merged same-named tables into one entry with the union of their columns, so a comparison reported phantom differences. Database Projects extracts correctly too — file names keep their short form for the default schema while the DDL inside is qualified, so an existing project does not churn and a second schema no longer overwrites the first. Schemas are colour-coded in the Schema Designer with a toggleable legend, shown only when a database actually has more than one. **Create Schema…** and **Drop Schema…** are available on a database, version-checked and verified end to end against the live server. **New Query in Schema…** opens an editor already scoped to a schema you pick. Autocomplete distinguishes same-named tables across schemas and inserts the qualified name. **Alter Schema…** covers both properties a schema has, using the `SET DEFAULT` syntax the server actually accepts (which differs from `CREATE SCHEMA`'s — established live). The Object Explorer now nests *database → schema → categories* when a database has more than one user schema, keeping the flat layout otherwise. Still missing: a per-connection default schema (a driver-level change — the pure-JS driver does not expose `isc_dpb_search_path`), and schema-level grants (search path, designer colour-coding, `CREATE`/`ALTER`/`DROP SCHEMA`) ([design doc](docs/roadmap/firebird6-schemas.md))

## Editor language features

- [x] **Hover, Go to Definition, and Document Symbols for `.sql` files** — until now `registerCompletionItemProvider` was the *only* language provider in the codebase. **Hover and Document Symbols are done**: hovering a table shows its columns and types, a column shows its type and every table holding it, and anything unrecognised shows nothing rather than an invented popup — reusing the completion provider's schema cache, so no new queries. The Outline view and breadcrumb now list a `.sql` file's statements, which needs no connection at all since it is pure text analysis over the existing statement splitter. **Go to Definition** completes it: `F12` on a table opens its generated `CREATE TABLE` behind a stable `firebird-ddl:` URI, so pressing it twice reuses one editor rather than piling up documents — verified end to end in a real VS Code. Scope worth knowing: it resolves *tables*, since that is all the completion cache holds ([design doc](docs/roadmap/sql-language-features.md))

## VS Code platform API adoption

`engines.vscode` is `^1.101.0` while VS Code stable is 1.131 — the extension runs fine, but the type floor hides ~13 months of API additions, several of which replace code written by hand here. Reviewed release by release; Marketplace-publishable work only (proposed APIs are tracked as a watch list in the design doc) ([design doc](docs/roadmap/vscode-api-adoption.md)).

- [x] Raise `engines.vscode`/`@types/vscode` to `^1.110.0` — the floor that covers every finalized API below
- [x] `context.secrets.keys()` (1.105) to reconcile stored passwords against saved connections and back a **Firebird: Clear All Stored Passwords** command — `CredentialStore` could store, read and delete a password but not enumerate them, so a secret orphaned by a failed delete stayed in SecretStorage permanently and invisibly. Reconciliation runs at activation (unawaited housekeeping); the command reuses the same code path with an empty live set
- [x] Ship Firebird dialect rules as a `contributes.chatInstructions` file (1.105), so agent mode and inline chat write Firebird-correct SQL instead of only the `@firebird` participant — the missing half of the existing Language Model Tools work. Note the rules had to be *written*: `prompts.ts` only says "use Firebird dialect", with the specifics buried in the `/migrate` prompt. Scoped to `.sql`/`.fbnb` files rather than every chat in the workspace
- [x] `ThemeIcon` webview tab icons (1.110) — results `table`, Schema Designer `type-hierarchy`, query plan `graph`, profiler `pulse`, mock data `beaker`. Five panels, not six: the notebook renderer is not a panel and Data API Builder opens a text document. Verified rendering in a real VS Code by the Playwright tier, which is the only tier that can see a codicon
- [x] `QuickInputButton.toggle`/`.location` and `QuickPick.prompt` (1.108/1.109) — object search gained a prompt explaining that Enter runs the object's primary action, and an inline toggle that pulls in system tables by re-querying (they are excluded in SQL, not in the UI). The Object Explorer filter turned out to already have its prompt. Scope: the toggle covers system *tables*, the only system category with an existing query
- [x] ~~Contribute the view container to the `secondarySidebar` (1.106)~~ — **declined after checking the premise.** The claim that this unlocks a layout users cannot otherwise get is wrong: VS Code lets users drag view containers to the Secondary Side Bar themselves. The contribution point only sets the *default*, and defaulting a database explorer away from the Activity Bar would be worse than the status quo — plus there are open reports of `secondarySidebar` declarations disturbing other extensions' view positions. Reasoning kept in the design doc

## Distribution

- [ ] Publish to the [Open VSX Registry](https://open-vsx.org/) alongside the VS Marketplace, so the extension installs in Cursor, VSCodium, and other non-Microsoft builds — vscode-pgsql ships exactly this (a Cursor build on Open VSX), and this extension's own MCP server already names Cursor as a target client while being uninstallable there. There is no release/publish workflow in `.github/workflows/` at all today (only `ci`, `e2e`, and `vscode-host`), so this is a packaging/release-automation item as much as a registry one

## Testing and CI

- [x] E2E test matrix covering Firebird 3, 4, 5, and 6 (snapshot) across Node.js 24-26, mirroring [node-firebird's own CI](https://github.com/mariuz/node-firebird/blob/master/.github/workflows/node.js.yml) so driver-compatibility regressions surface before they reach users on older or newer servers

Reviewed against [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s actual test pipeline — `codecov.yml`, `playwright.config.ts`, `.vscode-test.mjs`, and `build-and-test.yml`, not its documentation. (vscode-pgsql's public repository contains only a README, changelog, and images — no source, no tests, nothing to compare against.) Two design docs: [test-coverage-and-reporting.md](docs/roadmap/test-coverage-and-reporting.md) and [webview-ui-testing.md](docs/roadmap/webview-ui-testing.md).

- [x] **Measure test coverage** — `c8` for the unit tier and `@vscode/test-cli`'s own built-in coverage for the suite tier (no new dependency there; 0.0.12 already supported it). First measured baseline: **70.75 % of statements, 90.77 % of branches, 62.22 % of functions** across the 76 source files the unit tier loads, from 1 438 tests. CI now enforces a floor set from that baseline rounded down (70/90/62/70) — a ratchet to raise as the real figure rises, not an aspiration. Still project-level only: diff/patch coverage needs Codecov and a `CODECOV_TOKEN` secret. The 20 `vscode`-API-heavy files outside the unit tier are enumerated in the design doc
- [x] **Machine-readable test results** — JUnit XML from all three tiers via `mocha-multi-reporters` + `mocha-junit-reporter` (mssql's exact pair), surfaced as annotated `dorny/test-reporter` check runs for the unit and extension-host tiers, so a failure names the failing test instead of hiding in a job log. Failure stacks point at the TypeScript sources via Node's built-in `--enable-source-maps`, no `source-map-support` dependency needed. The 12-job e2e matrix uploads XML artifacts instead of creating twelve check runs
- [x] **Cross-platform unit-test matrix** — the unit tier now runs on Windows and macOS alongside Linux (`fail-fast: false`, `bash` everywhere, per-platform check runs and artifacts). Worth recording that this item's stated rationale was wrong: `isqlCandidates`/`gbakCandidates`/`dockerCandidates`/`quoteShellArgument` all take an injected platform parameter and the tests already pass `'win32'`/`'darwin'` explicitly, so Windows path and quoting behavior was under test from Linux all along. What the matrix genuinely adds is real `child_process` spawning (the class of bug behind 0.1.96 and 0.2.2), the `process.platform` default branch those tests bypass, real filesystem/CRLF behavior, and the never-taken Pageant branch in `ssh-tunnel.test.ts`. The coverage gate stays Linux-only so the ratchet is deterministic
- [x] **VSIX packaging + install smoke test** — `npm run test:vsix` (and the new `vsix-smoke.yml` workflow) packages the extension, installs the `.vsix` into a throwaway VS Code, and asserts against the *installed* copy: it activates, its commands register, and every path the manifest names actually exists in the package, plus the two esbuild outputs no manifest path references. It found a defect on its first run — `coverage/` (116 files, 7.86 MB) and `test-reports/` were being shipped, because the new coverage tooling wrote into directories `.gitignore` knew about and `.vscodeignore` did not; 230 files/4.8 MB → 111 files/3.55 MB. Also a prerequisite for the Open VSX item above
- [x] **Real-browser webview tests (Playwright)** — `npm run test:playwright` drives a real VS Code via `_electron.launch()`: four workbench specs plus one that adds a connection, runs a real query against a real Firebird server, and asserts the value appears **inside the results webview's document** — the first time any test here has confirmed a webview renders. Runs nightly inside the existing `vscode-host.yml` job, reusing its Firebird server and VS Code download rather than duplicating provisioning. Five environment traps had to be found by failing (chief among them `--password-store=basic`, without which SecretStorage rejects silently and the connection wizard ends with no connection and no error) — all documented in the design doc. Phase 3 is now done as well — the Schema Designer and query plan views are both driven end to end, and doing so found two real bugs in the plan view (it fetched its SQL after the webview had taken focus, and its fallback-text detection missed one of three shapes, so a table without indexes showed a parse error instead of the intended message). Remaining: webview coverage (phase 4)
- [x] **Nightly VS Code Insiders run** of the extension-host suite — a 03:00 UTC `schedule` trigger tests against Insiders while pushes and pull requests keep testing stable, plus a `workflow_dispatch` input to pick either manually. A scheduled run cannot block a merge, which is the intent: it reports, it does not gate
- [x] **Declare and test Workspace Trust** — now `{ supported: false, description }`, which changes no behaviour (a missing declaration already means "disabled in Restricted Mode") but replaces silence with a stated reason. It is the honest answer, not a cautious one: `firebird.isqlPath`/`gbakPath`/`dockerPath` are window-scoped, so a repository's own `.vscode/settings.json` can point them at any executable. `supported: "limited"` remains open and has a concrete prerequisite — making those three settings machine-scoped first. Verified by manifest tests (`src/test/manifest.test.ts`) rather than an untrusted-mode test config, which is not achievable for a `supported: false` extension: it does not load in Restricted Mode, so nothing would be left running to assert from

---

> **Note**: This roadmap is subject to change based on community feedback and contributions. Feature requests and suggestions are welcome via [GitHub Issues](https://github.com/mariuz/vscode-firebird-studio/issues).
>
> Inspired by the features announced in [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648), by [Microsoft's vscode-mssql extension](https://github.com/microsoft/vscode-mssql) for SQL Server, and by [Microsoft's vscode-pgsql extension](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql) for PostgreSQL.
>
> **Upstream review cutoffs** (2026-08-01): vscode-mssql through **1.44.1**, vscode-pgsql through **1.28.0** (plus its published feature documentation, not only its changelog), and the VS Code extension API through **1.131**. Both extensions' changelogs were last reviewed on 2026-07-31 and have shipped nothing new since, so the items added in this round come from reviewing their documented feature surface and the VS Code platform rather than their release notes. The testing items were reviewed separately against vscode-mssql's test configuration and CI workflows in source; vscode-pgsql publishes no source or tests, so it could not be reviewed for testing practice at all.

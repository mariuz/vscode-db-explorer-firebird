# Change Log

All notable changes to the "vscode-firebird-studio" extension will be documented in this file.

## Unreleased

### Fixed

- **Running a query showed an empty results grid.** Since 0.2.0, the grid for **Run Firebird Query** built itself before it was attached to the page, so it silently rendered no rows at all — the row count, the toolbar and the tabs all appeared as normal above an empty table. Results now render again.
- **Select All Records trimmed large tables without saying so.** The row limit (`firebird.maxResultRows`, 10 000 by default) applied correctly, but a table with more rows than that looked exactly like a table with precisely that many — there was no note. It now says the result is partial.
- **Show Object Privileges listed two tables' grants at once on Firebird 6.** With an `ORDERS` table in both `PUBLIC` and `SALES`, asking either one for its privileges listed all of both tables' grants merged together, so one table appeared to hold contradictory permissions. It now shows only the grants on the table you clicked. Firebird 5 and earlier are unaffected — they have no schemas for two tables to share a name across.
- **Four kinds of grant were shown as a single letter.** `USAGE` on a generator, exception or schema appeared as `G`, and the `CREATE`/`ALTER`/`DROP` privileges as `C`, `L` and `O`. All four are spelled out now.

### Changed

- **Set Connection Password, Visualize Schema and Search Objects now work from the Command Palette.** All three previously did nothing there — they were only reachable by right-clicking a database in the tree, which is not obvious and is awkward when the tree is scrolled or collapsed. Run them from the palette and they ask which connection you mean.
- **Refresh just one part of the connection tree.** Refresh was only available on the view's toolbar, where it re-reads every expanded node across every connection. Hosts, databases and folders such as **Tables** now have their own Refresh, so after creating a table you can re-read that one folder instead of the whole tree.
- **Object Search can now include system tables, without leaving the search.** Searching only ever covered your own objects, and system tables were reachable only by turning on a setting and browsing the tree. The search box gains a toggle that pulls them in — `RDB$RELATIONS`, `MON$ATTACHMENTS` and the rest — merged into the same alphabetical list and marked as system. It also now says what pressing Enter will do, which differs by object type.
- **Firebird Studio's editor tabs now have their own icons.** Query results, the Schema Designer, the query plan, the profiler and mock data all opened with the generic editor icon, so having several of them open at once left a tab strip you had to read word by word. Each now shows a distinct icon that follows your colour theme.

### Added

- **Page through a large result instead of stopping at the limit.** When a query returns more rows than the limit shows, the grid now offers **‹ Previous** / **Next ›**. Each page is fetched from the server as its own query rather than held in memory, so walking through a large table costs no more than one page at a time. It appears for a plain `SELECT` (including `WITH …` and `UNION`) on Firebird 3 and later; anything else keeps the previous behaviour. The grid says which rows you are looking at — *Rows 1–10000 of more* — and names a total only once it reaches the end, because finding the real total would mean counting the whole table on every page. If the query has no `ORDER BY`, it warns that pages can overlap or skip rows, since Firebird may order them differently each time. With unsaved row edits pending, changing page is refused rather than throwing them away.

- **Press F12 on a table name to see how it is defined.** Firebird keeps no source for a table, so Firebird Studio scripts one: its `CREATE TABLE`, generated from the connected database and opened read-only. Pressing F12 on the same table again reuses that document rather than opening another copy. It resolves table names — the same ones autocomplete offers.
- **A `.sql` file now has an outline.** The Outline view and the breadcrumb list the file's statements — `CREATE TABLE CUSTOMERS`, `INSERT INTO ORDERS`, `COMMIT` — so a long migration script can be navigated by clicking rather than scrolling. It works in any SQL file, with or without a database connection.
- **Hover a table or column name in a `.sql` file to see what it is.** A table shows its columns and their types; a column shows its type and which table it belongs to — and every table, when more than one has a column by that name. Nothing appears for keywords, aliases or anything else the connected database does not recognise. It reuses the schema information autocomplete has already loaded, so it costs no extra queries.

- **Copilot now knows Firebird's dialect everywhere, not just in `@firebird` chat.** Agent mode, inline chat and any other model could previously write `LIMIT 10`, `AUTO_INCREMENT` or `information_schema` against a Firebird database — all of which it rejects — because the dialect rules only ever reached the model through this extension's own chat participant. A dialect guide now ships with the extension and applies to any chat while you have a `.sql` or `.fbnb` file open: row limiting with `FIRST`/`SKIP`, `RDB$DATABASE` as the dummy table, identity columns and sequences, `EXECUTE BLOCK` and `SET TERM`, the `RDB$`/`MON$` catalogue, and qualifying names on Firebird 6 schemas.

- **Stored passwords for connections you deleted are now cleaned up, and there is a way to clear them all.** Passwords are kept in VS Code's encrypted secret storage, one per connection, and were only ever removed when a connection was deleted successfully — so a password could outlive its connection with no way for you, or the extension, to find it. Firebird Studio now reconciles the two when it starts, and a new **Firebird: Clear All Stored Passwords** command forgets every one of them (with a confirmation first). Requires VS Code 1.110 or later, which is now the minimum this extension supports.

- **Firebird 6 databases with more than one schema no longer show duplicate, indistinguishable tables — and actions on them now hit the table you clicked.** Firebird 6 introduced SQL schemas, and until now this extension did not know they existed: a database holding both `SALES.ORDERS` and `PUBLIC.ORDERS` showed two identical `ORDERS` entries, and every action on either one sent an unqualified `ORDERS` to the server, which resolved it through the session's search path — so clicking the `SALES` one ran against `PUBLIC.ORDERS` and showed the wrong columns, with nothing on screen to say so. Tables outside the default schema are now labelled `SCHEMA.TABLE`, and Select All Records, Drop Table and drag-into-editor all name the table explicitly. Nothing changes on Firebird 5 and earlier, which have no schemas — the extension asks the server its version first, and falls back to the old behaviour if it cannot tell. Expanding a table also lists only *its* columns now: previously the column lookup matched on the table name alone, so expanding either `ORDERS` showed `ID, NOTE, TOTAL` — a merger of both tables that corresponds to nothing real. **Views** get the same treatment — labels, `SELECT`, `DROP`, columns, and the source shown by **Edit View Source**, which previously could show you a different view of the same name. This now covers every object type that belongs to a schema — tables, views, stored procedures (including their parameters and source), triggers, generators, domains and exceptions. Roles are unaffected because they are database-wide rather than schema-scoped. **Database Projects extract correctly on multi-schema databases** — two same-named tables previously became one file containing a merged definition; each now gets its own, and the DDL inside names its schema. The same applies to views, procedures and triggers, including a procedure's parameter list, which previously mixed in the parameters of any same-named procedure in another schema. **The connection tree groups objects by schema** on a Firebird 6 database that has more than one — expand a database to see its schemas, and each one's tables, views and the rest beneath it. A database with a single schema looks exactly as it did. **Autocomplete tells same-named tables apart on Firebird 6** — two tables called `ORDERS` in different schemas previously appeared as two identical suggestions offering each other's columns. They now read as `ORDERS` and `SALES.ORDERS`, and accepting either inserts the schema-qualified name so the query means what you picked. **New Query in Schema…** opens a SQL editor already scoped to a schema you choose, so unqualified table names in it resolve there — the schema is set by a statement at the top of the document, so what runs is what you can see. **Alter a Firebird 6 schema's defaults** — its SQL security and character set — from the same menu. **Create and drop Firebird 6 schemas from the extension** — right-click a database for **Create Schema…** or **Drop Schema…**, or run them from the Command Palette. Dropping asks which schema and confirms first; Firebird itself refuses to drop one that still contains objects. On Firebird 5 and earlier both say so plainly rather than failing with a SQL error. **The Schema Designer colours tables by schema** on Firebird 6, with a **Schemas** button showing a legend — both appear only when a database has more than one schema, so nothing changes for everyone else. **Schema comparisons are correct on multi-schema databases** — a comparison previously merged same-named tables from different schemas into one, reporting differences for a table that exists in neither. **Data API specs are correct on multi-schema databases** — generating one previously merged same-named tables and could emit a nonsensical route repeating the same key parameter once per merged copy. Routes keep their short form (`/orders`) for tables in the default schema and stay qualified (`/sales.orders`) where that is what tells them apart. **AI features see the right schema too** — the `get_schema` tool behind both the MCP server and Copilot agent mode previously reported merged tables, so an agent could confidently write SQL against a table that did not exist. The **Schema Designer** diagram no longer merges same-named tables from different schemas into a single box — which also fixes columns appearing several times over in that box. **Show Object Privileges works on a schema**, listing who has been granted `USAGE` on it. **Script as Create** also names the table with its schema and no longer attaches another schema's foreign keys to it — with the same constraint name present in two schemas, the underlying catalogue query previously returned every combination of them.

- **Query results are now capped at 10 000 rows by default**, and the results view says when it trimmed something. Previously there was no ceiling at all: **Select All Records** on a large table asked the server for every row and pushed all of them into the results view, which is what made the extension struggle rather than the database. Two things changed. **Select All Records** now asks for at most the configured number (`SELECT FIRST n …`), so the rows never leave the server; and any result larger than the limit is trimmed before it is displayed, with a note above the grid — *"Showing the first 10000 of 50000 rows"* — naming the setting so you can raise it. Set `firebird.maxResultRows` to `0` for the old unlimited behaviour. One caveat worth knowing: for queries you write yourself the limit applies to what gets displayed, not to what the server produces — the driver returns a whole result set in one go, so a `SELECT` over a huge table still costs the server the same work.

### Changed

- **Opening an untrusted folder now tells you why Firebird Studio is unavailable**, instead of the extension simply not appearing. Its behaviour in VS Code's Restricted Mode is unchanged — it was already disabled there, because an extension that doesn't declare a Workspace Trust capability is disabled by default — but that was a default nobody had chosen and nothing explained. The extension now states the reason: it runs `isql`, `gbak`, and `docker` from paths that `firebird.isqlPath`/`firebird.gbakPath`/`firebird.dockerPath` can set, and reads connection definitions from `.vscode/firebird.json`, both of which a folder you haven't trusted controls. Trusting the folder enables the extension as before.

## 0.2.2 - 2026-07-31

### Fixed

- **Show Graphical Query Plan said "No SQL document opened!" even with a SQL file open.** The plan was looked up after the plan window had already taken focus, at which point VS Code no longer reports a text editor as active. It now reads the query before opening the window.
- **A table with no indexes made the plan view show a parser error.** On the default (pure-JS) driver Firebird Studio cannot produce a real execution plan and is meant to say so — "Graphical plans need the native driver" — but for a table without indexes it instead showed `Couldn't parse the plan: Expected "PLAN" but found "--"`.


- **Hardened the checks that detect `isql`, `gbak`, and `docker` on your machine.** These were four separately hand-written copies of the same logic, and the one bug already fixed in 0.1.96 (a working `isql` being reported as missing because the check hung waiting on standard input) could just as easily have been introduced into any of the others. They now share a single implementation that always closes standard input and, where it matters, confirms the tool identifies itself — so `isql` isn't confused with unixODBC's unrelated tool of the same name. No change in behavior when your tools are already detected correctly.

## 0.2.1 - 2026-07-31

### Fixed

- **Updated `node-firebird` to 2.14.1**, which corrects `TIMESTAMP WITH TIME ZONE` and `TIME WITH TIME ZONE` values being shifted by your machine's UTC offset when read back — on a `UTC+3` machine a value stored as 12:00 UTC came back as 09:00 UTC. Note the upstream fix is not quite complete: values that fall inside daylight saving time are still off by the DST hour (12:00 UTC in July reads back as 11:00 UTC), while values outside DST are now correct. Reported below for tracking.

### Changed

- **E2E tests can now run against a server that requires wire encryption.** They previously hard-coded encryption off, so they could only run against an unencrypted server — which is not the default for Firebird 4 and later. Set `FIREBIRD_WIRE_CRYPT=Enabled` to run them against a stock install; the default is unchanged. CI now runs one of its twelve e2e jobs with wire encryption on, which nothing covered before.

## 0.2.0 - 2026-07-31

### Added

- **Split a backup across multiple files.** Backup can now write a large database to several volumes — pick one path plus a file count and size, and the rest are named for you (`backup.fbk`, `backup.2.fbk`, …). Completes phase 4 of `docs/roadmap/backup-restore-options.md`, and with it the whole roadmap item.
- **Restore accepts multiple backup files**, so a split backup can actually be restored — select every volume and they're ordered for you. gbak needs all of them: given only the first, it fails with a confusing "cannot open backup file" that names your target database.
- **Parallel workers for backup and restore.** Offered only when the server is configured for it — the extension reads `MaxParallelWorkers` from the server first, because asking gbak for more workers than allowed makes it print a warning and quietly run single-threaded anyway.

## 0.1.99 - 2026-07-31

### Added

- **Data API specs can now leave columns out.** Generating a spec no longer means exposing every column of every table you include — a table can be scoped to specific columns, or have columns excluded, so a `PASSWORD_HASH` or internal audit column stays out of the generated REST surface. **Generate Data API Spec with Copilot...** understands this too ("expose users read-only but not the password hash"). Two rules keep the result usable: hiding a primary-key column drops that table's by-id routes (the URL needs it), and hiding a mandatory column that has no default makes the table read-only, since a create could never satisfy it. Completes phase 5 of `docs/roadmap/data-api-builder.md`.

## 0.1.98 - 2026-07-31

### Added

- **Export a SQL Notebook result to a file.** Notebook result grids gain an **Export…** button alongside Copy as CSV/JSON, which saves the result as a CSV or JSON file. It exports exactly what you're looking at — the current filter and sort — and if the result was capped when it was displayed (notebook grids show the first 1000 rows), the confirmation says so rather than quietly exporting a partial file. Completes phase 4 of `docs/roadmap/sql-notebooks.md`.

## 0.1.97 - 2026-07-31

### Added

- **Restore Database now offers gbak's restore options.** A picker before the restore lets you replace an existing database (rather than the restore just failing because the target file exists), restore metadata only, restore one table at a time, skip validity conditions, skip shadow files, and override the page size. Leaving everything unchecked behaves exactly as before. Completes phase 2 of `docs/roadmap/backup-restore-options.md`.
- **A command preview before restoring.** Because a restore can overwrite a live database, the exact `gbak` command that's about to run is shown for confirmation first — with the password redacted. The preview is built from the same argument list that gets executed, so it can't drift from what actually happens.
- **Backup and Restore can now be cancelled.** Both show a cancellable progress notification; cancelling actually terminates the `gbak` process rather than just hiding the indicator, and the run is recorded as cancelled in the Background Tasks view. Completes phase 3 of the same roadmap item.

## 0.1.96 - 2026-07-31

### Fixed

- **isql was reported as "not found" on machines where it was installed and working.** The check that probes for the executable ran `isql -z` and waited for it to exit — but real isql prints its version banner and then reads standard input, so it never exited, hit the timeout, and was written off as missing. Both **Connect with isql** and **Run File with isql** were therefore unavailable, telling you to install client tools you already had. The probe now closes stdin (and confirms the version banner, so unixODBC's unrelated `isql` isn't mistaken for Firebird's).
- **A failing isql script now reports the failure.** Previously the run was launched and forgotten: a script that failed produced no error notification and no Background Tasks entry, unlike Backup/Restore. It now surfaces Firebird's own error text (`Statement failed, SQLSTATE = ... / -Table unknown ...`) rather than just an exit code. Note that isql exits **0** on a failed *login* — only a failed statement exits non-zero — so the output is checked too, otherwise a completely failed run looks like a success.

### Changed

- **isql now runs in a normal terminal rather than a VS Code task**, which removes the requirement to have a workspace folder open — you can run a single `.sql` file with no folder open. Where the shell supports shell integration, its exit code is tracked and reported in the Background Tasks view; where it doesn't, the command is still typed into the terminal exactly as before. Implements `docs/roadmap/isql-terminal-shell-integration.md`.

## 0.1.95 - 2026-07-31

### Added

- **Copilot agent mode can now use Firebird directly.** Five language model tools — list connections, get schema, run query, get query plan, and run write statement — are registered with VS Code's Language Model Tools API, so Copilot's agent mode can inspect and query your databases without any MCP server or separate client process. They're also `#`-referenceable in ask mode (`#firebirdSchema`, `#firebirdQuery`, …). Writes keep the existing per-connection opt-in (**Toggle MCP Server Write Access**) *and* ask you to confirm the exact statement before running it. Implements `docs/roadmap/language-model-tools.md`.

### Changed

- **Minimum VS Code version is now 1.101** (was 1.93). The extension already used 1.101 APIs for its MCP server integration — the declared minimum simply hadn't kept up, and `@types/vscode` was loose enough (`^1.32.0`, resolving to 1.125) that nothing caught the gap. Both are now pinned to the same version, so an accidental use of a newer API fails the build instead of shipping.
- **The MCP server's five tools and the new language model tools are now one implementation** (`src/shared/db-tools.ts`) behind a small transport interface, rather than two copies. What's refused, what the write gate checks, and how results are shaped can no longer drift between them — and that logic is now unit-tested, which it wasn't before.

## 0.1.94 - 2026-07-31

### Added

- **Quick Queries.** Save SQL you run constantly and bind it to your own keyboard shortcut. Nine `Firebird: Run Quick Query 1…9` commands ship with **no default keybindings** — assign whichever you want in VS Code's Keyboard Shortcuts editor, then fill the `firebird.quickQueries` setting (each entry takes `sql`, plus optional `name` and `action`, where `action: "open"` puts the SQL in an editor for review instead of running it immediately). A query can contain `${selectedText}`, replaced with the editor's current selection — so one binding covers every table: highlight a name, press the key, and `SELECT COUNT(*) FROM ${selectedText}` runs against it. Bookmarks can claim a slot too, via **Assign to Quick Query Slot** in the Bookmarks view. Implements `docs/roadmap/quick-queries.md`.

## 0.1.93 - 2026-07-31

### Fixed

- **"Run Statement Under Cursor" no longer misbehaves when the cursor isn't inside a statement.** The fallback for a cursor sitting in the whitespace between two statements now runs the document through the same batch-aware path as "Run Firebird Query" (`Driver.runBatch()`), instead of sending the whole multi-statement document to the server as a single unsplit query that failed at the first `;`. As a side effect the two commands now share one implementation, so running a DDL statement under the cursor also gets the same success notification and Object Explorer refresh that "Run Firebird Query" already gave it, rather than an empty one-cell results grid.
- **A trailing `-- comment` with no newline at end of file no longer breaks statement lookup.** The statement splitter's offset ranges were cut short at such a comment (and at an unterminated `/* ...`), so placing the cursor in that last statement's trailing comment matched no statement at all and silently ran the whole document instead.
- **Dragging a column or table whose name is a reserved word missing from the completion list now quotes it.** `OFFSET`, `ROW`, `BOOLEAN`, `OVER` and `WINDOW` are real Firebird reserved words with no entry in the editor's completion word list, and were being inserted unquoted; identifier quoting now checks against the full reserved-word list from the Firebird language reference.

## 0.1.92 - 2026-07-18

### Added

- **Drag Object Explorer entity into editor.** Drag a table, view, column, procedure, generator, or domain from the Firebird Explorer tree straight into a SQL editor to insert its identifier — correctly double-quoted (and reserved-word-safe) only when it actually needs it. Implements `docs/roadmap/drag-identifier-into-editor.md`.

## 0.1.91 - 2026-07-18

### Added

- **Run Statement Under Cursor.** A new `firebird.runCurrentStatement` command (default keybinding `Ctrl+Shift+Enter`, `Cmd+Shift+Enter` on macOS) runs just the one SQL statement your cursor happens to be in, out of a multi-statement document, without requiring a selection first. Implements `docs/roadmap/run-statement-under-cursor.md`.

## 0.1.90 - 2026-07-18

### Changed

- **Updated `node-firebird` (the pure-JS driver used unless `firebird.useNativeDriver` is on) from 2.3.4 to 2.14.0.** Ten releases' worth of fixes land with it — most visibly, a long-standing bug where a table with several `VARCHAR` columns could come back with a column's value missing/garbled (surfaced in this project's own suite as two previously-known, pre-existing test failures — both now pass, confirmed by two clean full-suite runs against a real Firebird 6.0 server) is fixed. Also: the Firebird 6.0 Protocol 20 "prepare hang" is fixed (protocol 20 is now negotiated by default against FB 6.0 servers), dead idle pooled connections are now proactively evicted instead of handed out, and an unlistened driver-internal `'error'` event can no longer crash the extension host — the affected operation's own callback still receives the error either way. No code changes were needed on Firebird Studio's side; `docs/roadmap/connection-lost-indicator.md`'s error-shape detection (added earlier this same day) was re-verified against the new version's source and gained one extra recognized message pattern (`connection-health.ts`) for a fallback error string the updated driver can now produce.

## 0.1.89 - 2026-07-18

### Added

- **Connection Lost Indicator.** A dropped active connection (server restart, network blip) is now surfaced immediately instead of only showing up as a raw error the next time you happen to run a query: the status bar item switches to a warning state ("⚠ connection lost") with a one-click "Reconnect" action, and a database's tree node gets a matching badge the next time it fails to expand — cleared automatically the moment a query or expand against that connection succeeds again. Detected by recognizing the shape of a real connection failure (socket reset/refused/timed out, Firebird's own "unable to complete network request") rather than adding a new polling cycle. Implements `docs/roadmap/connection-lost-indicator.md`.

## 0.1.88 - 2026-07-18

### Added

- **Backup Database: options.** Backup now offers a quick options picker before the file dialog — skip garbage collection, compress the backup file, back up metadata only, or use the non-transportable format — leaving everything unchecked behaves exactly as before. First phase of `docs/roadmap/backup-restore-options.md`.
- **New `firebird.gbakPath` setting**, mirroring the existing `firebird.isqlPath` — lets you point Backup/Restore Database at a `gbak` executable that isn't on `PATH`.

### Fixed

- Backup/Restore Database now reports a clear "Could not find the gbak executable..." error immediately when `gbak` isn't on `PATH` and no `firebird.gbakPath` is set, instead of only discovering this after already stepping through the options picker and file dialog and hitting a raw `spawn gbak ENOENT` error.

## 0.1.87 - 2026-07-18

### Added

- **Cross-extension connection sharing: permission gate, query execution, opt-in write access.** Other VS Code extensions can now run a real read-only query (`firebird.connectionSharing.runQuery`) against a connection they've been granted access to — the first call from a new extension prompts you once to Approve or Deny; the choice is remembered. A new "Review Connection Sharing Permissions..." command lets you see, revoke, or deny access later, and — a separate, explicit opt-in with its own confirmation — grant write access (`firebird.connectionSharing.runWriteQuery`, a single INSERT/UPDATE/DELETE). Passwords never cross this boundary. Completes `docs/roadmap/cross-extension-connection-api.md`.

## 0.1.86 - 2026-07-18

### Added

- **Cross-extension connection discovery API (phase 1).** Other VS Code extensions can now discover this workspace's saved Firebird connections and the currently active one via new `firebird.connectionSharing.listConnections`/`firebird.connectionSharing.getActiveConnection` commands — read-only, never including a password. No query execution and no permission gate yet (planned for later phases of `docs/roadmap/cross-extension-connection-api.md`); this first phase is scoped to information already visible in the tree.

## 0.1.85 - 2026-07-18

### Added

- **Generate Migration Script.** A new "Generate Migration Script..." command compares two saved connections and opens a runnable SQL script — column/table/view/procedure/trigger/domain/generator/exception/role/user changes included, not just tables — for review before you run it yourself. Reuses Database Projects' existing publish machinery rather than the read-only `Schema Diff` text report. Completes `docs/roadmap/schema-diff-migration-script.md`.

## 0.1.84 - 2026-07-18

### Added

- **Background Tasks view.** A new "Background Tasks" panel (in the Firebird activity-bar container) tracks Docker container provisioning and database backup/restore alongside their existing progress notifications, so you can check whether one finished even after its toast is gone. A "Clear Completed Tasks" button removes finished entries, keeping anything still running. Completes `docs/roadmap/connection-management-enhancements.md` (all four phases now done).

## 0.1.83 - 2026-07-18

### Added

- **Edit Connection.** A new "Edit Connection..." command lets you change a saved connection's fields in place — the same wizard used to add a connection, pre-filled with its current values, saved back over the same connection (not a new one). Leaving a field unchanged keeps its current value, including the password. Not available for connections declared in a workspace's `.vscode/firebird.json` (edit the file directly instead). Third of four phases in `docs/roadmap/connection-management-enhancements.md`.

## 0.1.82 - 2026-07-18

### Added

- **Copy Connection String.** A new right-click command on a database node copies a Firebird-native `host/port:database` connection string (a bare path for embedded connections) to the clipboard — the password is never included, matching this extension's usual credential-handling posture. Second of four phases in `docs/roadmap/connection-management-enhancements.md`.

## 0.1.81 - 2026-07-18

### Added

- **Add Connection wizard: Test Connection step.** After collecting every field, the wizard now offers to test the connection for real before saving — surfacing a wrong password or unreachable host immediately rather than only on first use. Optional and never blocking (a failed test still offers "Save Anyway"); not offered for SSH-tunneled connections, whose credential can't be tested until the connection is actually saved. First of four phases in `docs/roadmap/connection-management-enhancements.md`.

## 0.1.80 - 2026-07-18

### Added

- **Query results: "View Table Diagram" button.** A new "🗺 View Table Diagram" button in the row-editing toolbar opens the table currently being edited directly in the Schema Designer, pre-focused on it. Completes `docs/roadmap/query-results-enhancements.md` (all five phases now done).

## 0.1.79 - 2026-07-18

### Added

- **Query results: configurable grid font.** New `firebird.resultsFontSize`/`firebird.resultsFontFamily` settings (mirroring vscode-mssql's `mssql.resultsFontSize`/`mssql.resultsFontFamily`) customize the font used by the Query Results grid. Also documented that column show/hide was already available via the grid's existing "Columns" toolbar button. Third and fourth of five phases in `docs/roadmap/query-results-enhancements.md`.

## 0.1.78 - 2026-07-18

### Added

- **Query results: selection aggregations.** Selecting a range of cells in the results grid now shows a live `Count` / `Sum` / `Avg` / `Min` / `Max` readout next to the grid toolbar, computed over whatever cells in the selection actually parse as numbers — no need for the whole selected column to be numeric first. Second of five phases in `docs/roadmap/query-results-enhancements.md`.

## 0.1.77 - 2026-07-18

### Added

- **Query results: Text View mode.** A new "📄 Text View" toolbar button in the query results grid renders the current result set as aligned plain text (header, dashed separator, one line per row, `NULL` shown explicitly) with a one-click Copy button — useful for pasting a whole result set elsewhere without HTML/DataTables formatting, or for a very wide result set where the table layout is awkward. First of five phases in `docs/roadmap/query-results-enhancements.md`.

## 0.1.76 - 2026-07-18

### Fixed

- **Query Plan Visualizer: "Actual Plan" could hang indefinitely.** `getActualPlan()` fetched its two result sets (per-record-source access paths and their timing stats) concurrently over the same database connection — the pure-JS driver's single request/response socket can stall forever when two query round-trips are interleaved on it. Both queries now run sequentially, same connection, no behavior change beyond no longer being able to hang.
- **Query results/profiler/query-plan webviews: a rapid open-then-close could crash.** Closing one of these panels while its HTML was still loading (a narrow race, most reachable via fast repeated opens) hit a stale reference and threw instead of no-oping.

### Added (tests)

- Extension Development Host coverage for Live Profiler, Query Plan Visualizer, Data API Builder, and SSH Tunneling — the last four roadmap items with no suite-tier coverage, driving each feature's real classes against a real Firebird server (and, for SSH Tunneling, a real throwaway `sshd`) rather than mocks.

## 0.1.75 - 2026-07-18

### Added

- **MCP Server: opt-in write access.** A new `run_write_query` tool lets an MCP client run a single INSERT/UPDATE/DELETE against a connection — but only one that's *both* exposed to the MCP server *and* separately write-enabled via the new **Toggle MCP Server Write Access** command, which requires an explicit modal confirmation before granting it. Every write attempt, successful or not, is logged to a new MCP write-audit log (**Show MCP Write Audit Log**), and relayed live into the output channel as it happens. `run_query`/`get_query_plan` remain unconditionally read-only, unaffected.

## 0.1.74 - 2026-07-18

### Added

- **Flat File Import Wizard: large-file streaming for CSV/TSV.** A large CSV/TSV file is no longer read entirely into memory — the wizard now infers the schema from a bounded preview sample and streams the actual import row-by-row, buffering only one insert batch (200 rows) at a time. Small/typical files behave exactly as before. JSON files still read entirely into memory (a disclosed, deliberate scope cut — see the roadmap doc).

## 0.1.73 - 2026-07-18

### Added

- **Database Projects: safer column-type changes in Publish.** A column type change Firebird's own `ALTER COLUMN ... TYPE` would reject outright (narrowing a `VARCHAR`, `VARCHAR` → `INTEGER`, anything involving `BLOB`, widening a `NUMERIC`'s decimal places, ...) is now migrated via an add-copy-drop-rename sequence instead, so the generated script actually runs rather than failing loudly. A change Firebird already accepts directly (e.g. widening a `VARCHAR`) is unaffected. Skipped for a column that's part of a primary key or foreign key — those still use the previous behavior.

## 0.1.72 - 2026-07-18

### Added

- **SSH Tunneling: workspace connections.** A `.vscode/firebird.json` connection can now declare an `sshTunnel` (host/port/user/authMethod/privateKeyPath) the same way the Add Connection wizard already does. The actual SSH password/passphrase still can't be committed — set or rotate it from the tree's new **Set SSH Tunnel Password** command, which also works for any existing connection (previously the only way to change one was deleting and re-adding the whole connection).

## 0.1.71 - 2026-07-18

### Added

- **SQL Notebooks: rich results renderer.** A `.fbnb` cell's query results now render in a sortable/filterable/paginated grid (with Copy as CSV/Copy as JSON) instead of a plain markdown table, via a new custom notebook output renderer. A markdown fallback is still included in case the renderer can't load.

## 0.1.70 - 2026-07-17

### Added

- **Flat File Import Wizard: Copilot-assisted type/naming suggestions.** When creating a new table, an optional "Suggest types with Copilot" step reviews the locally-inferred schema against sample rows — useful for cases a mechanical sniffer can't judge, like a numeric-looking ZIP code that should stay `VARCHAR` to keep its leading zero, or giving a cryptic header a clearer name. Purely optional: the wizard works exactly as before if skipped or if Copilot isn't installed.

## 0.1.69 - 2026-07-17

### Added

- **Database Projects: domains, roles, exceptions, and users.** Extract/Build/Publish now cover these alongside tables/views/procedures/triggers/generators. A changed domain's CHECK constraint round-trips correctly; a new user is scripted commented-out (Firebird can't export a real password) so it's never silently created with a guessable one.

### Fixed

- **Database Projects: generators could be created too late.** A trigger or column default referencing a generator via `GEN_ID()` could fail because the generator was created after it. Generators are now created first.
- **UTF8 VARCHAR/CHAR lengths were reported 4x too large.** Affected extracted table/domain/procedure-parameter DDL, the tree explorer's field-length display, and Data API Builder's OpenAPI `maxLength` — anywhere a column's declared length was read from the database for a UTF8-charset connection.
- **A Build/Publish script consisting entirely of a comment could fail to run.** SQL statement splitting now correctly treats a comment-only chunk as nothing to execute, rather than sending it to the server as if it were a statement.

## 0.1.68 - 2026-07-17

### Added

- **Data API Builder: Copilot-assisted scoping.** A new **Generate Data API Spec with Copilot...** command takes a plain-English description (e.g. "expose customers and orders as read-only") and generates a scoped-down OpenAPI spec — only the tables you described, with read-only tables losing their POST/PUT/DELETE routes.

## 0.1.67 - 2026-07-17

### Added

- **Flat File Import Wizard: map onto an existing table.** Import Flat File now offers a second target mode alongside "create a new table" — pick an existing table and the wizard proposes a column mapping by matching file headers to column names, shown as an editable preview before running, with per-column override via a quick pick when the automatic match needs correcting.

### Fixed

- **Boolean columns showed as "UNKNOWN" type.** The tree's field-type query never recognized Firebird's BOOLEAN column type; it now does.

## 0.1.66 - 2026-07-17

### Added

- **SQL Notebooks: persisted connection binding.** A `.fbnb` notebook now remembers which saved connection it's bound to across reopening the file or restarting VS Code — previously it re-prompted every time. The connection id (never its password) is stored in the notebook's own metadata.

### Fixed

- **Code completion could silently fail with no active connection.** `firebird.codeCompletion.database` (on by default) queried the database for completions even before any connection was active, throwing internally on every keystroke (caught and logged, but completions never populated). Now correctly requires an active connection.

## 0.1.65 - 2026-07-17

### Fixed

- **MCP server: live refresh on Toggle MCP Server Exposure.** Toggling a connection's MCP exposure from the tree now updates an already-running MCP client session immediately — previously it required restarting the client to pick up a newly-exposed (or newly-hidden) connection.

## 0.1.64 - 2026-07-17

### Added

- **Live Profiler: Sessions view.** A new `Sessions` view mode lists open transactions with isolation mode, lock timeout, Auto-Commit/Read-Only flags, duration, and record lock wait/conflict rates, flagging whichever transaction is the database's oldest active one (the most likely to be holding back garbage collection) — Firebird's monitoring tables have no true lock-wait graph, so this surfaces the closest proxies it does expose.

## 0.1.63 - 2026-07-16

### Added

- **Live Profiler: charted dashboard and Queries drill-down.** The Live Profiler (**Monitor Database**) now has `Table` / `Dashboard` / `Queries` view modes. Dashboard shows live sparkline charts (connections, cache hit %, page reads/writes per sec) with a 1 min / 5 min / 15 min / All time-range selector, over the same polled data the activity table already fetches. Queries ranks currently active statements by a chosen metric (reads/writes/fetches/seq/idx per sec).

## 0.1.62 - 2026-07-15

### Added

- **Query Plan Visualizer: Actual Plan.** A new "Actual" view mode (alongside Diagram/Table/Icicle, in both the standalone Query Plan panel and the result-view "Query Plan" tab) re-runs a read-only `SELECT` for real and shows Firebird 5.0+'s genuine per-node execution stats (open/fetch counts and elapsed time) via the engine's built-in `RDB$PROFILER` package — not just the estimated plan. Requires Firebird 5.0 or newer; shows a clear message on older servers.

## 0.1.61 - 2026-07-14

### Added

- **Query Plan Visualizer: icicle chart view.** A third "Icicle" view mode (alongside Diagram and Table) renders the plan as stacked horizontal bars, sized by each node's share of the plan's scans (Firebird's plan text has no cost/row estimates, so this is a structural proxy) and color-flagging natural/unindexed scans — in both the standalone panel and the result-view "Query Plan" tab. This completes every phase of the original Query Plan Visualizer design doc except the actual-vs-estimated overlay.

## 0.1.60 - 2026-07-14

### Added

- **Query Plan Visualizer: Copilot "Analyze" action.** A "🤖 Analyze" button in both the standalone Query Plan panel and the result-view "Query Plan" tab asks Copilot to explain the execution plan in plain English, flag expensive operations (natural scans, unsupported sorts), and suggest concrete indexes.

## 0.1.59 - 2026-07-14

### Added

- **Query Plan Visualizer: a "Query Plan" tab in the results panel.** Every batch query result now has a "🧭 Query Plan" toggle (alongside the existing "🤖 Analyze" button) that shows that specific statement's execution plan — diagram, sortable table, zoom/pan, detail panel — inline, without opening the separate `firebird.showEstimatedPlan` panel. Plans are fetched and cached per statement.

### Internal

- Extracted `interpretPlanText()` into `src/shared/plan-parser.ts` (fallback-text detection + parsing + error formatting), shared by the standalone Query Plan panel and the new result-view tab instead of two independently-drifting copies.

## 0.1.58 - 2026-07-14

### Added

- **Graphical Query Plan Visualizer: sortable table view and "Import Plan".** A new "Table View" toolbar toggle shows the same parsed plan as a flat, sortable one-row-per-node table (Node/Table/Access Method/Index(es)/Depth) alongside the existing node diagram, with selection now synced between both views. A new "Import Plan" button loads a plan previously saved as plain text (e.g. copied from `firebird.explainPlan`'s output) with no live connection needed.

### Fixed

- The Query Plan Visualizer's node-diagram selection highlight (`fb-selected`) never actually applied — clicking a node updated the detail panel but the diagram's own re-render compared against a layout-tree object that no longer existed by the time it ran.

## 0.1.57 - 2026-07-14

### Added

- **Live Profiler: filter, pin, and Kill/Rollback actions.** The connection activity table (`firebird.database.monitorDatabase`) now has a toolbar filter box (matches user/address/state/statement text), a per-row pin to keep a connection sorted to the top, and per-row "Kill" (force-detach) / "Rollback" (roll back the active transaction) actions — both gated behind a confirmation dialog naming the affected connection before anything runs.

## 0.1.56 - 2026-07-13

### Added

- **MCP Server: `run_query` and `get_query_plan` tools** — the `firebird-mcp` server (any MCP-compatible AI client, not just this extension's own `@firebird` Copilot chat) can now execute a single read-only `SELECT` (or `WITH ... AS (...) SELECT`) statement and fetch an index-metadata-based execution plan, in addition to the existing `list_connections`/`get_schema`. Both are unconditionally read-only with no opt-out — anything else (INSERT/UPDATE/DELETE/DDL/EXECUTE BLOCK, or more than one statement) is rejected before a connection is even opened.

### Internal

- `extractTableNames()`/the index-metadata query and plan renderer moved from `src/shared/driver.ts` into a new dependency-free `src/shared/sql-analysis.ts`, shared by both the extension host and the MCP server's spawned subprocess (which can't import `driver.ts` at all, since that pulls in `vscode`).

## 0.1.55 - 2026-07-13

### Fixed

- **Database Projects (Extract/Build/Publish), "Script as Create", and "Edit Procedure" now correctly reconstruct procedures with input/output parameters.** `RDB$PROCEDURE_SOURCE` excludes a procedure's parameter list and `RETURNS` clause entirely — previously silently dropped, generating an invalid `CREATE OR ALTER PROCEDURE`/`ALTER PROCEDURE`. A new `RDB$PROCEDURE_PARAMETERS` query reconstructs the full `(param TYPE, ...) RETURNS (param TYPE, ...)` header, including NUMERIC/DECIMAL precision. Parameterless procedures are unaffected (this was already correct for them).
- `NodeProcedure#editProcedure()`'s `ALTER PROCEDURE` scaffold now re-specifies the full parameter list even for a body-only edit — unlike `ALTER TRIGGER`, Firebird requires it (confirmed directly against a live server); omitting it made every parameter "unknown" inside the edited body.

## 0.1.54 - 2026-07-13

### Added

- **Database Projects: Publish/migrate** — a new **Publish Database Project...** command diffs a saved project (from **Extract Database Project...**) against a live target connection's current schema and generates an executable migration script (`ALTER TABLE`/`CREATE OR ALTER PROCEDURE`/etc.), always opened for review before running. Table/column adds, drops, type/NOT NULL/default changes, primary key changes (with dependent foreign keys safely cycled around the change), new/dropped foreign keys, and new/changed procedures/triggers/views/generators are all covered; drops are opt-in (off by default).

### Fixed

- `ALTER TABLE ... DROP COLUMN` isn't valid Firebird syntax (no `COLUMN` keyword) — fixed in the new Publish feature's column-drop statement.
- `src/shared/sql-splitter.ts` mis-split a multi-statement script whenever a `-- comment` (with no `SET TERM`) preceded a `CREATE PROCEDURE`/`TRIGGER` block, breaking BEGIN/END depth tracking and corrupting the statement.
- **Database Projects' Extract/Build have been silently generating invalid DDL for every trigger, and every procedure via "Script as Create"/"Edit Procedure"**, since before Publish existed: `RDB$PROCEDURE_SOURCE` never includes the `AS` keyword, and `RDB$TRIGGER_SOURCE` never includes the required `FOR <table> ACTIVE/INACTIVE BEFORE/AFTER <event>` header (both confirmed directly against a live server) — neither was ever reinserted. Only ever noticed now because Publish is the first feature to actually *execute* a generated script rather than just open it for review.

### Known limitation

- A procedure with input/output parameters is not correctly reconstructed by Extract/Build/Publish/Script-as-Create/Edit-Procedure — `RDB$PROCEDURE_SOURCE` excludes the parameter list and `RETURNS` clause entirely, and nothing in this extension captures that data yet. Parameterless procedures are unaffected.

## 0.1.53 - 2026-07-13

### Added

- **SSH tunneling** — connect to a Firebird server reachable only through an SSH bastion/jump host. The Add Connection wizard has a new step (password, private key, or SSH agent authentication) that tunnels the connection through a local forwarded port, opened once per connection and reused across queries rather than re-established each time. Uses the `ssh2` package.

### Fixed

- `Driver.getQueryPlan()`'s native-driver detection and `NativeClient`'s own internal connect path are now routed correctly through any active SSH tunnel — both were exposed only while wiring in tunnel support and are fixed alongside it.

### Added

- **Parameterized query execution** — a new **Run Parameterized Query** command (`Ctrl+Alt+Shift+Q`) for `.sql` files containing named placeholders like `:customerId`. Prompts for each distinct placeholder's type (String/Integer/Float/Date/Boolean/NULL) and value, rewrites them to Firebird's positional `?` binding, and runs the query with real bound parameters rather than inlined text.

### Fixed

- The native driver (`firebird.useNativeDriver`) silently ignored any query parameters passed to it — `NativeClient.queryPromise()` never forwarded its `args` through to `connection.executeQuery()`. Only exposed once something in this codebase actually tried to bind parameters through the native driver path; fixed alongside Parameterized Query Execution.

## 0.1.51 - 2026-07-13

### Added

- **`/migrate` Copilot chat command** — paste (or have open in the editor) DDL from MySQL, PostgreSQL, SQL Server, Oracle, or legacy InterBase and ask `@firebird /migrate` to convert it to Firebird SQL, mapping data types (AUTO_INCREMENT/SERIAL/IDENTITY, TEXT, BOOLEAN, ENUM, ...) to their closest Firebird equivalent.

## 0.1.50 - 2026-07-13

### Added

- **Dev Container template** (`.devcontainer/`) — Node.js + a real `firebirdsql/firebird:5` server (the same image/config the CI workflows use), pre-seeded via `scripts/seed-test-db.js` on first create. Open the repo in VS Code and choose **Reopen in Container** for a working Firebird server with no local install, for quick-start/demo/contribution scenarios.

## 0.1.49 - 2026-07-13

### Added

- **AI analysis of query results** — a **🤖 Analyze** button on each result grid (when the query that produced it is known, e.g. from **Run Firebird Query**) sends the result set to Copilot for a concise summary — notable patterns, outliers, counts worth mentioning — opened beside the editor. Reuses the same prompt-building pattern as `/explain`/`/optimize`.

## 0.1.48 - 2026-07-12

### Added

- **Object Explorer Filters** — right-click a category folder (Tables, Views, Stored Procedures, Triggers, Generators, Domains, Roles, Exceptions, Users, System Tables) and choose **Filter Objects...** to narrow it to names containing a substring (case-insensitive); the folder's label shows the active filter, and **Clear Filter** removes it. Distinct from the existing Object Search command, which is a one-shot fuzzy lookup across every object type at once rather than narrowing what the tree itself shows.

## 0.1.47 - 2026-07-12

### Added

- **"What's New" notification** — shown once after an update (not on first install), summarizing the new version's `CHANGELOG.md` entry with a **Show Full Changelog** button. Silent on a fresh install and on same-version re-activations (e.g. a window reload).

## 0.1.46 - 2026-07-12

### Added

- **Getting Started walkthrough** — an interactive, checklist-style onboarding flow (VS Code's native Walkthroughs UI, shown from the Welcome page or **Help: Get Started**) covering adding a connection, exploring the tree, setting the active database, running a first query, and next steps (IntelliSense, snippets, mock data, `@firebird` Copilot Chat). Complements the existing static `docs/getting-started.md`.

## 0.1.45 - 2026-07-12

### Added

- **Object privileges/grants viewer** — right-click a table, view, procedure, or role for a new **Show Object Privileges** command, listing its grants (grantee, privilege, grant-option, and column for column-level grants) read from `RDB$USER_PRIVILEGES`, in the results grid.

## 0.1.44 - 2026-07-12

### Added

- **Generic "Script as Create" / "Script as Drop"** — right-click any table, view, procedure, trigger, generator, domain, role, exception, user, or index for one pair of commands that reconstructs its DDL for review, instead of each object type needing its own bespoke edit command. Users get a clearly-marked placeholder (Firebird never exposes an existing password); everything else is a genuine reconstruction from live metadata.

### Fixed

- `NUMERIC`/`DECIMAL` columns now round-trip with their real precision/scale (e.g. `NUMERIC(9,2)`) in Database Projects' Extract and the new Script as Create, instead of showing up as their bare underlying `INTEGER`/`BIGINT`/`DOUBLE` storage type — confirmed the exact `RDB$FIELD_SUB_TYPE`/`PRECISION`/`SCALE` semantics directly against a live Firebird server.

## 0.1.43 - 2026-07-12

### Added

- **Chart visualization for query results** — a new **📊 Chart** button on every result grid reveals a Bar/Line/Pie/Scatter chart alongside the grid, picking any column as the X-axis and a numeric column as the Y-axis (auto-detected). Hand-rolled SVG, no new charting dependency.

## 0.1.42 - 2026-07-12

### Added

- **AI Query Actions in the editor** — right-click SQL (or select part of it) → **AI: Explain Query** / **AI: Optimize Query** to get Copilot's analysis without opening the Chat panel first, opened in a new document beside your editor. Reuses the exact same prompts as the `@firebird` chat participant's `/explain`/`/optimize` slash commands.

## 0.1.41 - 2026-07-12

### Added

- **MCP Server** (`firebird.mcp.enabled`, off by default) — exposes a `list_connections`/`get_schema` MCP server to any MCP-compatible AI client (Claude Desktop, Cursor, VS Code Copilot Agent mode), independent of this extension's own `@firebird` Copilot Chat participant. Right-click a database → **Toggle MCP Server Exposure** to opt a connection in — nothing is exposed by default even with the setting on, and credentials never reach the MCP client itself. Read-only schema inspection only in this pass; no query-execution tool yet.

## 0.1.40 - 2026-07-12

### Added

- **Color-coded connection groups** — right-click a database → **Set Connection Color...** tags it with a color shown in its tree icon and (when active) the status bar; **Set Connection Group...** organizes it under a named folder in the Explorer tree instead of by host.
- **Paste a connection string** — the "Add New Connection" wizard now offers to prefill every field from a pasted `firebird://user:password@host:port/database` string instead of stepping through each prompt by hand.

### Fixed

- Renaming a database, or tagging the *currently active* connection with a color/group, now actually updates the status bar immediately — previously this went through a code path that only reacts to the active connection's id changing, silently no-op'ing for same-connection field edits.

## 0.1.39 - 2026-07-12

### Added

- **Create Local Firebird Container** — provisions a brand-new Firebird server as a Docker container (pick a version, port, SYSDBA password, database name, and ephemeral-vs-persistent-volume storage), waits for it to accept connections, then adds it as a saved connection automatically. Extends the existing "Add New Connection" Docker option's container *detection* with container *creation*.

## 0.1.38 - 2026-07-12

### Added

- **Object Search** — right-click a database → **Search Objects...** to fuzzy-search every table, view, procedure, trigger, generator, and domain by name in one QuickPick, then jump straight to it: tables/views open their data, procedures/triggers/domains open for editing, and generators show their current value.

## 0.1.37 - 2026-07-12

### Added

- **Create, rename, and drop whole databases** — **Create New Database...** (Command Palette) creates a brand-new database file and adds it as a connection; right-click a database → **Rename Database...** (embedded connections only) renames its file on disk, or **Drop Database...** to permanently delete it (modal confirmation — there is no undo).

## 0.1.36 - 2026-07-12

### Added

- **Firebird Database Projects** — right-click a database → **Extract Database Project...** writes the connected schema out as one `.sql` file per table/view/procedure/trigger/generator, plus a manifest recording a safe deploy order; **Build Database Project...** (Command Palette) concatenates an extracted project into one reviewable deploy script.

## 0.1.35 - 2026-07-12

### Added

- **Data API Builder** — right-click a database → **Generate Data API Spec...** to produce an OpenAPI 3.0 document (list/create/get/update/delete routes per table, JSON Schema types inferred from your columns) opened as plain JSON for review — a reviewable artifact for your own REST/GraphQL backend, not a server this extension runs itself.

## 0.1.34 - 2026-07-12

### Added

- **SQL Notebooks** — a new `.fbnb` notebook type (**New Firebird SQL Notebook** command): mix markdown and SQL cells, run a cell to execute it against a picked connection and see rows rendered as a table, DDL/DML success messages, or errors, right below the cell.

## 0.1.33 - 2026-07-12

### Added

- **Flat File Import Wizard** — right-click a database → **Import Flat File...** to import a CSV, TSV, or JSON file into a new table: it sniffs a Firebird column type per column (INTEGER/BIGINT/NUMERIC/BOOLEAN/DATE/TIMESTAMP/VARCHAR), lets you review/edit the generated `CREATE TABLE` before it runs, then batch-inserts every row with a progress notification.

## 0.1.32 - 2026-07-12

### Added

- **Transaction settings** — four new settings (`firebird.transaction.isolationLevel`, `.lockTimeoutSec`, `.readOnly`, `.waitMode`) apply to every transaction Firebird Studio opens to run a query or batch, letting you set e.g. Snapshot isolation or a lock-wait timeout without editing SQL. `lockTimeoutSec` is honored by the pure-JS driver only — the native driver's transaction API has no numeric lock-timeout option, only wait/no-wait.

## 0.1.31 - 2026-07-12

### Added

- **Configurable results-grid shortcuts** — a new `firebird.shortcuts` setting (mirroring vscode-mssql's `mssql.shortcuts`) lets you rebind the keyboard shortcuts for toggling edit mode, adding a row, applying changes, freezing the first column, and copying a selection as `INSERT`/`IN (...)`, all scoped to whichever result grid has focus

## 0.1.30 - 2026-07-12

### Added

- **Results grid: column freeze, show/hide, and copy-as-SQL** — a "Columns" button lets you toggle individual result columns on/off, "❄ Freeze Column" pins the first column while you scroll horizontally, and click/shift-click a range of cells then "Copy as INSERT" or "Copy as IN (...)" to copy ready-to-paste SQL built from the selection

## 0.1.29 - 2026-07-12

### Added

- **Live Profiler** — **Monitor Database** now opens a continuously-refreshing connection activity view instead of a one-time snapshot: see every connection's user, remote address, current statement, and live I/O rates (reads/writes/fetches per second), auto-updating on an interval (`firebird.profiler.pollIntervalMs`, default 3s) with Pause/Resume and manual refresh

## 0.1.28 - 2026-07-12

### Added

- **Graphical Query Plan** — new "Show Graphical Query Plan" command (`Ctrl+Alt+Shift+E` / `Cmd+Alt+Shift+E`) renders the active query's execution plan as an interactive, pannable/zoomable node diagram instead of plain text: click a node to see its access method and index, toggle to the raw `PLAN` text if you just want to copy it. Requires the native driver, same as the existing text-based explain plan.

## 0.1.27 - 2026-07-12

### Added

- **Ask Copilot** in the Schema Designer — describe a schema change in plain English ("add an ORDERS table linked to CUSTOMERS") and it edits the open diagram directly: adds/modifies tables and columns, draws relationships, then lets you review and generate/execute the resulting DDL exactly like a manual edit would

## 0.1.26 - 2026-07-12

### Added

- **Visual Schema Designer** — replaces the separate read-only "Visualize Schema" diagram and single-table "Create/Alter Table" designer with one merged, editable multi-table designer: add new tables and columns, draw or delete foreign key relationships between columns by dragging, and alter existing tables' columns and primary key, all from the same whole-database canvas. Generates a consolidated `CREATE`/`ALTER TABLE` DDL script for review before running, correctly handling constraint drop/re-add ordering (e.g. when changing a primary key that a foreign key elsewhere still depends on). The **Visualize Schema**, **Create Table**, and **Alter Table** commands all now open this designer, focused appropriately — no new commands to learn.

### Fixed

- Executing generated DDL from the table/schema designer now runs each statement individually instead of sending the whole (possibly multi-statement) script as one query, which could silently fail to run everything past the first statement.

## 0.1.25 - 2026-07-12

### Added

- **Workspace-level database configuration** — commit a `.vscode/firebird.json` declaring a project's connection(s) and everyone who opens the folder gets it in DB Explorer automatically, no manual setup required. Supports marking one connection `"default": true` to auto-activate on open, JSON schema-backed autocomplete/validation, and never stores passwords in the file (see `docs/connection-setup.md`)
- **Set Connection Password** — new context-menu action on any database connection to set/update its stored password without removing and re-adding it; the only way to attach a password to a workspace connection, but works for manually-added ones too

## 0.1.24 - 2026-07-12

### Added

- **Alter Table** now opens the visual Table Designer pre-populated with the table's existing columns, instead of a plain-text scaffold — edit column types, sizes, defaults, NOT NULL, and the primary key, and it generates the `ALTER TABLE ADD/DROP/ALTER COLUMN` statements for you. Renaming a column in place is detected as a genuine rename rather than a drop-and-recreate that would lose data.

## 0.1.23 - 2026-07-12

### Added

- **Create** actions for object types that only supported edit/drop before: right-click the **Stored Procedures**, **Triggers**, **Views**, **Generators**, and **Domains** folders to scaffold a new one (opened as SQL for you to fill in and run, the same way the existing edit/alter actions work)
- **Alter Domain** — right-click an existing domain for an `ALTER DOMAIN` scaffold pre-filled with its current type

## 0.1.22 - 2026-07-12

### Added

- **Connection pooling** — new `firebird.enableConnectionPooling` setting (off by default) keeps idle connections open and reuses them for subsequent queries against the same saved connection instead of reconnecting every time, with `firebird.connectionPool.maxSize` and `firebird.connectionPool.idleTimeoutMs` controlling pool size and idle lifetime. Works with both the native and pure-JS drivers.

### Fixed

- The pure-JS driver now fails loudly with a clear message when asked to open an "embedded" connection, instead of silently connecting to a Firebird server on `127.0.0.1:3050` — `node-firebird` has no embedded-engine support, so embedded databases require `firebird.useNativeDriver`

## 0.1.21 - 2026-07-12

### Added

- `@firebird` Copilot Chat participant: new `/designSchema` slash command — paste or open sample data (CSV, JSON, or plain-text rows) and it suggests Firebird `CREATE TABLE` DDL with inferred column types and constraints

## 0.1.20 - 2026-07-12

### Added

- Every table now shows an **Indexes** folder alongside its columns, listing standalone user-created indexes (constraint-backed indexes for primary/foreign/unique keys are already shown via the column icons, so they're deliberately excluded here to avoid duplication)
- **Create Index** (regular or unique, any number of columns) and **Drop Index** actions

### Fixed

- `Generate Mock Data` no longer errors when a table's tree children include the new Indexes folder — it was previously assuming every child was a column

## 0.1.19 - 2026-07-12

### Added

- Object Explorer: databases now show a **Users** folder (Firebird 3+'s SQL-visible `SEC$USERS`), alongside **Roles**, which now supports **Create Role** in addition to the existing Drop
- **Create User**, **Change Password**, and **Drop User** actions, using Firebird's native `CREATE USER`/`ALTER USER`/`DROP USER` SQL — no `gsec` shell-out required
- Passwords for these actions are entered through a masked input box and applied via a direct connection that bypasses the extension's normal query-execution path, so the plaintext password is never written to session query history or the output channel log (unlike a typical typed-and-run `CREATE USER ... PASSWORD '...'` statement, which would be)

## 0.1.18 - 2026-07-12

### Added

- **Add New Connection**'s Docker option now auto-detects Firebird servers running in local Docker containers instead of just assuming `localhost:3050`: it lists every running container that publishes Firebird's port (3050), pre-fills the host/port from whichever one you pick, and — when the container's `FIREBIRD_DATABASE` env var is set (the official `firebirdsql/firebird` image's convention) — suggests the database path too, still editable before you continue
- New `firebird.dockerPath` setting for when the `docker` executable isn't on `PATH`
- Falls back to the previous static `localhost:3050` behavior when Docker isn't installed or no matching containers are running, so nothing changes for setups without Docker

## 0.1.17 - 2026-07-11

### Added

- Object Explorer: databases now show **Roles** and **Exceptions** folders alongside the existing Tables/Views/Procedures/Triggers/Generators/Domains, each with a **Drop** action
- Optional **System Tables** folder, listing Firebird's own `RDB$` metadata tables, gated behind the new `firebird.showSystemObjects` setting (off by default — most users never need to browse these directly)
- Firebird-specific syntax highlighting for `.sql` files: `EXECUTE BLOCK`, `SET TERM`, `CREATE OR ALTER`, `RECREATE`, `SUSPEND`, `POST_EVENT`, exception/context keywords, and `RDB$`/`MON$`/`SEC$` system identifiers now get their own highlight scopes on top of the base SQL grammar

### Internal

- The E2E CI workflow now runs its test suite against a matrix of Node.js 24/25/26 × Firebird 3/4/5/6-snapshot (12 jobs), mirroring [node-firebird's own CI](https://github.com/mariuz/node-firebird/blob/master/.github/workflows/node.js.yml), to catch driver-version compatibility regressions before they reach users. No extension behavior changed.

## 0.1.16 - 2026-07-11

### Added

- isql in the integrated terminal, similar to "psql in the terminal" in Microsoft's PostgreSQL extension: right-click a database → **Connect with ISQL** opens an integrated terminal already connected via `isql`/`isql-fb`; right-click in a `.sql` editor → **Run File with ISQL** saves the file and runs it non-interactively with `isql -i`. Credentials are passed via the `ISC_USER`/`ISC_PASSWORD` environment variables rather than the visible command line, matching how the PostgreSQL extension uses `PGPASSWORD`. New `firebird.isqlPath` setting for when the executable isn't on `PATH`.

## 0.1.15 - 2026-07-11

### Added

- Schema visualizer: right-click a database → **Visualize Schema** for an interactive entity-relationship diagram of its tables, columns, and foreign key relationships, with pan, zoom, fit-to-view, a minimap, and an auto-layout that recalculates table positions. Primary key columns are marked; hovering a table highlights its relationships. Firebird has no per-schema/namespace concept the way PostgreSQL does, so this always maps the whole database rather than one schema at a time.

## 0.1.14 - 2026-07-11

### Added

- Editable result grids: enable editing on any result set to update cells, add new rows, or mark rows for deletion, then apply the changes directly to the database in one step — replacing the previous "generate an UPDATE statement to copy/paste" helper, which only handled a single-row UPDATE and never supported INSERT or DELETE
- Row targeting is now primary-key aware (looked up automatically from the table), falling back to matching every column when a table has no primary key; NULL values are compared with `IS NULL` instead of the always-false `= NULL`
- Applying changes asks for confirmation first, then reports success/failure per row, with failed rows highlighted so you know exactly what didn't apply

## 0.1.13 - 2026-07-11

### Fixed

- Fixed "SQL error code = -204, Data type unknown, Implementation limit exceeded, COLUMN" when editing a stored procedure, trigger, or view's source. These fetch their `RDB$*_SOURCE` BLOB via `CAST(... AS VARCHAR(32000))` with no explicit character set; since connections default to UTF8 (up to 4 bytes/char), that cast needed up to 128000 bytes — well past Firebird's 32767-byte column limit — and always failed. Now casts to an explicit `CHARACTER SET UTF8` sized to fit (8191 chars), and warns in the opened scaffold if a very large body still hits that limit.

## 0.1.12 - 2026-07-11

### Fixed

- Fixed "Your user name and password are not defined" when expanding a table, view, or stored procedure in the Explorer view, or editing a view/procedure/trigger's source. `NodeDatabase` resolved the saved connection's password from SecretStorage before listing its own children, but handed the *unresolved* connection down to the `NodeTable`/`NodeView`/`NodeProcedure` objects it created; those then connected directly without resolving it themselves. Every direct-connect call site now resolves the password first via a shared `Driver.resolvePassword()` helper.

## 0.1.11 - 2026-07-11

### Added

- Session query history now automatically logs *every* query run through the extension — predefined tree actions (Select All Records, Show Table Info, Drop Table/View/Procedure/Trigger/Generator/Domain, Table Designer DDL, etc.), not just the main "Run Query" editor command
- Each history entry now records which connection it ran against; re-running a history entry (**History → Run**) replays it against that original connection instead of whatever happens to be active, falling back to the active connection with a notice if the original was removed
- History entries display their connection in the tree and tooltip

### Changed

- Deduplicated the "extract database filename from a connection path" logic that had been copy-pasted across `Global`, the connection picker, and the database tree node into a single shared helper

## 0.1.10 - 2026-07-11

### Added

- Batch execution: running a query now correctly handles multiple `;`-separated statements in a single document, including `CREATE`/`ALTER PROCEDURE`, `TRIGGER`, `FUNCTION`, and `EXECUTE BLOCK` bodies (with or without the isql `SET TERM ^ ;` convention used by this extension's own snippets) as a single atomic statement instead of splitting on their internal semicolons

### Fixed

- Upgraded TypeScript to 6.0.3 and fixed the resulting strict-mode findings across the codebase
- Corrected `wireCrypt` connection option translation for the non-native driver, which previously could hang the connection instead of erroring
- Fixed several GitHub Actions CI issues (unit tests running the wrong test tier, workflows resolving an unpinned global TypeScript instead of the project's version)

## 0.1.9 - 2026-04-07

### Changed

- Renamed extension to **Firebird Studio for VS Code** (`vscode-firebird-studio`)
- Updated publisher to `mariuz`, repository and bug tracker URLs to `github.com/mariuz/vscode-firebird-studio`
- Updated logo to a new Firebird-inspired flame/phoenix icon
- Updated README, docs, and all references to remove legacy fork branding

## 0.1.8 - 2026-03-26

### Added

- [CONTRIBUTING.md](CONTRIBUTING.md) — comprehensive contributing guide covering development setup, coding style, commit conventions, and PR process
- [docs/getting-started.md](docs/getting-started.md) — step-by-step tutorial for first-time users (install, connect, explore, query, export)
- [docs/connection-setup.md](docs/connection-setup.md) — detailed connection configuration reference including native driver and WireCrypt setup
- [docs/sql-snippets.md](docs/sql-snippets.md) — full reference for all 45 Firebird SQL snippets with examples and quick-reference table
- Improved [README.md](README.md) with structured settings table, documentation index, and links to new guides
- Marked **Documentation and Community** roadmap items as completed in [ROADMAP.md](ROADMAP.md)

## 0.1.7 - 2026-03-26

### Added

 - Added [ROADMAP.md](ROADMAP.md) with planned features inspired by [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648)
 - Planned: Enhanced Object Explorer with views, stored procedures, triggers, generators, domains, and roles
 - Planned: Intelligent IntelliSense improvements with context-aware schema completion
 - Planned: AI-powered enhancements with GitHub Copilot integration for Firebird SQL
 - Planned: Session query history and batch query execution
 - Planned: Query performance analysis with explain plan integration
 - Planned: Editable result grids for data manipulation
 - Planned: Firebird 4.x/5.x wire protocol and authentication support
 - Planned: Database management features (create/alter/drop objects, backup/restore, monitoring)
 - Planned: SQL formatting, schema diff, and linting

## 0.1.4 - 2023-09-20

 - Fixed mockaroo integration
 - Added experimental native driver support
 - Fixed icon in sidebar
 

## 0.1.3 - 2023-02-15

 - Added type or field information to completion window
 - Only autocomplete fields after table

## 0.1.0 - 2023-02-14

 - Added support to table alias in completion

### Fixed
 - Fixed query results webview

## 0.0.4 - 2019-03-11

### Fixed
 - SELECT bug after previous DELETE

## 0.0.3 - 2018-11-27

### Added

- [Firebird Role](https://firebirdsql.org/file/documentation/reference_manuals/fblangref25-en/html/fblangref25-ddl-role.html) - User role input added to **Add New Connection** wizard.

## 0.0.2 - 2018-11-18

### Added

- [SQL Mock Data Generator](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator)

## 0.0.1 - 2018-11-14

- Initial release

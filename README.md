<h1 align="center">
  <br>
    <img src="https://github.com/mariuz/vscode-firebird-studio/blob/master/resources/img/icon.png?raw=true" alt="Firebird Studio icon" width="128">
  <br>
  Firebird Studio for VS Code
  <br>
</h1>
<h4 align="center">Explore, query, and manage your Firebird&reg; databases without leaving VS Code.</h4>

[![GitHub release](https://img.shields.io/github/v/release/mariuz/vscode-firebird-studio)](https://github.com/mariuz/vscode-firebird-studio/releases/latest)

This extension allows you to connect directly to your [Firebird&reg; databases](https://firebirdsql.org/), list tables and fields, run queries, display/export results and more.

![banner](https://github.com/mariuz/vscode-firebird-studio/blob/master/images/banner.jpg?raw=true)

## Features

### Features in Firebird Studio

- **Table alias** in code completion
- [_Experimental_] Native driver support (required for WireCrypt support)
- 45 Firebird SQL **code snippets** (type `fb` in any `.sql` file)
- [SQL Mock Data Generator](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator)
- Manage multiple database connections
- List hosts, databases, tables, views, stored procedures, triggers, generators, domains, roles, exceptions, and users inside **Explorer View**, with an optional System Tables folder for browsing Firebird's own `RDB$` metadata
- **Create/drop roles and users**, and change user passwords, without leaving the Explorer — no `gsec` required, and passwords never touch session query history or logs
- **View, create, and drop indexes** per table, alongside its columns
- Firebird-specific syntax highlighting for PSQL blocks (`EXECUTE BLOCK`, `SET TERM`, `SUSPEND`, `RDB$`/`MON$` identifiers, and more)
- [Firebird Reserved Words](https://firebirdsql.org/refdocs/langrefupd25-reskeywords-full-reswords.html) **Code Completion**
- Table and field names **Code Completion**
- Run Firebird **SQL** queries
- Run **predefined** custom queries
- View results in a **table**
- **Realtime** results filtering and sorting
- Export results to **JSON**, **CSV**, **XSLX** or **PDF** file
- **Session query history** — every query you run is logged automatically (with the database it ran against, row count/duration, and any error), and can be reopened or re-run from the **History** view
- **Editable result grids** — enable editing on any result set to update cells, add rows, or mark rows for deletion, then apply the changes directly to the database (primary-key aware, with a confirmation before anything is written)
- **Schema visualizer** — an interactive entity-relationship diagram of a database's tables, columns, and foreign key relationships, with pan/zoom, auto-layout, and a minimap
- **isql in the integrated terminal** — connect with `isql`/`isql-fb` for backslash-command-style administration, or run a `.sql` file through it directly, without leaving VS Code
- **Graphical query plan** — an interactive, pannable/zoomable diagram of a query's execution plan (native driver required)
- **Live Profiler** — a continuously-refreshing view of active connections and open transactions, with Table/Dashboard/Queries/Sessions view modes, filtering/pinning, and Kill/Rollback actions
- **Results grid**: freeze/show-hide columns, and copy a cell selection as an `INSERT` statement or a SQL `IN (...)` clause
- **Configurable results-grid shortcuts** (`firebird.shortcuts`) and per-session **transaction settings** (isolation level, lock timeout, read-only, wait mode)
- **Flat File Import Wizard** — import a CSV/TSV/JSON file into a new table or map it onto an existing one, with column-type inference and large-file streaming
- **SQL Notebooks** — a native `.fbnb` notebook editor mixing markdown and SQL cells, with results rendered per cell
- **Data API Builder** — generate an OpenAPI 3.0 REST spec (one CRUD route set per table) from the connected schema
- **Database Projects** — extract the connected schema into a folder of versioned `.sql` files, build one back into a deployable script, or **Publish** it (or a **Generate Migration Script...** diff between two connections) as a targeted `CREATE`/`ALTER`/`DROP` migration
- **Create, rename, and drop whole databases** from the connection tree, not just objects within one
- **Object Search** — fuzzy-search every table, view, procedure, trigger, generator, and domain by name in one connection
- **Create Local Firebird Container** — provision a brand-new Dockerized Firebird server from the extension
- **Color-coded connection groups**, and paste a full connection string to prefill the "Add New Connection" wizard
- **MCP Server** — expose opted-in connections to any MCP-compatible AI client (Claude Desktop, Cursor, VS Code Copilot Agent mode): schema inspection, read-only query execution and query plans by default, plus an explicit, separately-confirmed opt-in for a single write query, fully audit-logged
- **AI Query Actions in the editor** — right-click SQL for Explain/Optimize without opening the Copilot Chat panel first
- **Chart visualization for query results** — Bar/Line/Pie/Scatter charts alongside the results grid
- **Generic "Script as Create" / "Script as Drop"** — reconstruct DDL for any object type from one pair of tree actions

## Getting Started

For a detailed step-by-step walkthrough see **[docs/getting-started.md](docs/getting-started.md)**.

Quick start:

1. Not yet on the VS Code Marketplace — download the `.vsix` from the [latest GitHub release](https://github.com/mariuz/vscode-firebird-studio/releases/latest) and install it: `code --install-extension vscode-firebird-studio-*.vsix`, or in VS Code's Extensions view, `···` menu → **Install from VSIX...**
2. Restart VS Code and click the **Firebird flame icon** in the Activity Bar.
3. Click **+** in the DB Explorer title bar to add a connection.
4. Right-click your database and choose **Set Active**, then open a `.sql` file and press `Ctrl+Alt+Q` to run a query.

## Using the Extension

### Add a New Connection

Click the **+** (Add New Connection) icon in the DB Explorer title bar. Paste a connection string (e.g. `firebird://sysdba:masterkey@localhost:3050/employee`) at the first prompt to prefill every field at once, or leave it empty and the Connection Wizard guides you through host, port, database path, username, password, and optional role instead. Your connection appears in the tree when the wizard completes.

Choosing **Docker** as the connection type auto-detects Firebird containers currently running on your machine — pick one from the list and its published port (and, when available, its database path) are filled in for you. Falls back to the previous `localhost:3050` default if Docker isn't installed or no matching container is running. To provision a brand-new one instead of connecting to an existing one, run **Create Local Firebird Container...** from the Command Palette.

Right-click any connection → **Set Connection Color...** tags it with a color (shown in its tree icon, and in the status bar while it's active) or **Set Connection Group...** to organize it under a named folder in the tree instead of by host — handy for telling Production apart from Staging/Dev at a glance.

For advanced options (native driver, WireCrypt) see **[docs/connection-setup.md](docs/connection-setup.md)**.

### MCP Server

Turn on `firebird.mcp.enabled`, then right-click a database → **Toggle MCP Server Exposure** for each connection you want reachable — nothing is exposed by default even with the setting on. Any MCP-compatible AI client (Claude Desktop, Cursor, VS Code's own Copilot in Agent mode) can then call `list_connections`/`get_schema` to inspect an opted-in connection, and `run_query`/`get_query_plan` to run a read-only query or fetch its plan, independent of this extension's own `@firebird` Copilot Chat participant. Write access is a separate, explicit opt-in — right-click a database → **Toggle MCP Server Write Access** (its own modal confirmation) enables `run_write_query`, a single INSERT/UPDATE/DELETE per call; every write attempt, successful or not, is logged to a write-audit log (**Show MCP Write Audit Log**). Passwords never reach the MCP client either way.

### AI Query Actions in the Editor

Select a query (or just place your cursor in one) and right-click → **AI: Explain Query** or **AI: Optimize Query** — the same prompts the `@firebird` chat participant's `/explain`/`/optimize` slash commands use, but without opening the Copilot Chat panel first. The response opens in a new document beside your editor. Requires GitHub Copilot Chat installed and signed in.

### Explore Database Contents

Expand the database node to see category folders: **Tables**, **Views**, **Stored Procedures**, **Triggers**, **Generators**, **Domains**, **Roles**, **Exceptions**, and **Users**. Expand any table to see its columns, with type/length and primary/foreign/unique/not-null markers shown inline, plus an **Indexes** folder for standalone user-created indexes (primary/foreign/unique-key indexes are already shown via the column icons, so they're not duplicated here).

> **Tip:** Right-clicking a tree node shows available actions such as **Select All Records**, **Show Table Info**, or **New Query**.

Enable **firebird.showSystemObjects** to also show a **System Tables** folder, listing Firebird's own `RDB$` metadata tables (read-only — browsing and querying only, no drop).

### Managing Users and Roles

Right-click the **Roles** folder → **Create Role**, or the **Users** folder → **Create User** (prompts for a password). Right-click an existing user for **Change Password** or **Drop User**; roles support **Drop Role**. These use Firebird's native `CREATE`/`ALTER`/`DROP USER` SQL (Firebird 3+) rather than shelling out to `gsec`, and passwords are sent through a connection that bypasses query history/logging — they're never written to disk in plaintext by the extension.

### Managing Indexes

Right-click a table's **Indexes** folder → **Create Index**, choose the column(s) (comma-separated, for a composite index) and whether it should be unique. Right-click an existing index for **Drop Index**.

### Script as Create / Script as Drop

Right-click any table, view, procedure, trigger, generator, domain, role, exception, user, or index → **Script as Create** or **Script as Drop** — one pair of actions works for every object type, opening the reconstructed DDL in an editor for review (never run automatically). Most object types get a genuine reconstruction from live metadata; a **user**'s "Script as Create" is a clearly-marked placeholder instead, since Firebird never exposes an existing user's password (and this extension never stores one in plaintext to begin with).

### Visual Schema Designer

Right-click a database node → **Visualize Schema** (or a table → **Create Table**/**Alter Table**) to open the Schema Designer: an editable entity-relationship diagram of every table, its columns, and its foreign key relationships (primary key columns are marked).

- **Pan**: drag an empty area of the canvas. **Zoom**: scroll wheel, or the **+**/**−** buttons.
- **Fit to View** zooms and centers so every table is visible; the **minimap** in the corner shows your position in a large schema, and is clickable to jump around.
- Click a table to open its column editor in the side panel — add/remove/edit columns, change the primary key. **+ Add Table** creates a new one; drag from a column's right edge to another table's column to draw a foreign key, and click an edge + <kbd>Delete</kbd> to remove one.
- **Ask Copilot** — describe a change in plain English (e.g. "add an ORDERS table linked to CUSTOMERS") and it edits the diagram for you, the same as if you'd made the change by hand.
- **Generate DDL in Editor** / **Execute DDL** produce the `CREATE`/`ALTER TABLE` statements needed to apply your changes — always reviewable before running.
- Dropping an existing table isn't done here — use **Drop Table** from the tree instead.
- The diagram doesn't update automatically after schema changes made elsewhere — use **Refresh** to reload it (this discards any unsaved edits on the canvas, after a confirmation).

Firebird doesn't have PostgreSQL-style schemas/namespaces, so unlike similar tools this always shows the whole database rather than one schema at a time.

### Set an Active Database

Before running queries, set an active database:

- Right-click the database node → **Set Active**, or
- Click the Firebird indicator in the status bar (bottom-left) and select a database.

> **Tip:** The **New Query** command sets the selected database active and opens a new SQL document.

### Running SQL Queries

Press `Ctrl+Alt+Q` or right-click the editor → **Run Firebird Query**.
If you select text first, only the selection runs; otherwise the whole document runs as a **batch**.

Each `;`-separated statement in the document gets its own tab in the results view, showing its row count (or error) at a glance. `CREATE`/`ALTER PROCEDURE`, `TRIGGER`, `FUNCTION`, and `EXECUTE BLOCK` bodies are treated as a single statement — including the isql `SET TERM ^ ;` convention used by this extension's own snippets — so the semicolons inside a procedure body don't get split into separate statements.

### Using isql in the Terminal

For backslash commands, `.sql` script testing, or anything the graphical query editor doesn't cover:

- Right-click a database → **Connect with ISQL** opens an integrated terminal running `isql`/`isql-fb`, already connected — no need to type `-user`/`-password` yourself.
- With a `.sql` file open, right-click in the editor → **Run File with ISQL** saves the file and runs it through `isql -i` against the active database.

Requires the Firebird client tools (`isql` or `isql-fb`) to be installed and on your `PATH`; if the extension can't find them, set the **firebird.isqlPath** setting to the executable's full path. Credentials are passed via the `ISC_USER`/`ISC_PASSWORD` environment variables rather than the visible command line.

### Editing Query Results Directly

Any result grid (single query or a batch panel) can be edited in place:

1. Click **Enable Editing**. The **Table** field pre-fills automatically when it can be detected from the query; the extension looks up that table's primary key so edits target exactly one row.
2. Edit a cell directly in the grid, click **+ Add Row** for a new row, or click the ✕ next to a row to mark it for deletion.
3. Click **Apply Changes**. You'll be asked to confirm before anything is written; each change reports success or failure individually, and failed rows stay highlighted so you can retry.

Without a primary key, edits fall back to matching every column in the row — still safe, but less precise if the table has duplicate rows.

### SQL Snippets

Type `fb` in any `.sql` file and pick a snippet from the IntelliSense list. There are 45 snippets covering DML, DDL, PSQL control flow, and common functions.

See the full list in **[docs/sql-snippets.md](docs/sql-snippets.md)**.

### SQL Mock Data Generator

Right-click a table → **Generate Mock Data**. Requires a [Mockaroo API key](https://www.mockaroo.com/users/sign_up). See [wiki](https://github.com/mariuz/vscode-firebird-studio/wiki/SQL-Mock-Data-Generator) for details.

### Graphical Query Plan

With a query in the editor, press `Ctrl+Alt+Shift+E` (`Cmd+Alt+Shift+E` on macOS) or run **Show Graphical Query Plan** — an interactive, pannable/zoomable diagram of the execution plan opens: click a node to see its scan method and index in a side panel, or toggle to the raw `PLAN` text to copy it. Requires the native driver (`firebird.useNativeDriver`); with the pure-JS driver it falls back to a text summary of relevant index metadata instead of a real plan.

### Live Profiler

Right-click a database → **Monitor Database** opens a continuously-refreshing view of every connection to that database, with four view modes (a toolbar switcher, no extra polling to switch between them):

- **Table** — one row per connection: user, remote address, current statement, and live I/O rates (page reads/writes/fetches per second)
- **Dashboard** — sparkline charts for connection count, cache hit %, and page I/O, with a time-range selector (1/5/15 min or all)
- **Queries** — the current connections ranked by a chosen rate metric
- **Sessions** — one row per open transaction, with lock-wait/conflict rates and the oldest active transaction (the closest Firebird proxy for "what's blocking garbage collection") flagged

A filter box narrows by user/address/state/statement text, and a **⭐ Pin** button keeps a row sorted to the top regardless of filter. Every row also has **Kill** (force-detach the connection) and, for one with an open transaction, **Rollback** — both behind a modal confirmation naming who/what is affected. The polling interval is controlled by `firebird.profiler.pollIntervalMs` (default 3s).

### Results Grid: Freeze, Show/Hide, and Copy as SQL

Every result grid has a **Columns** button (show/hide any column) and a **❄ Freeze Column** toggle (pins the first column while you scroll a wide result horizontally). Click a cell, then shift-click another to select a rectangular range, and use **Copy as INSERT** or **Copy as IN (...)** to copy ready-to-paste SQL built from the selection — handy for turning a few rows you spotted into a repro `INSERT` or a `WHERE id IN (...)` filter elsewhere. All of these (plus **Enable Editing**, **+ Add Row**, and **Apply Changes**) also have configurable keyboard shortcuts — see `firebird.shortcuts` below.

Click **📊 Chart** to reveal a chart alongside the grid: pick Bar, Line, Pie, or Scatter, and which column is the X-axis and which (numeric) column is the Y-axis — a numeric column is picked for you by default. Renders straight from the loaded result set, capped to the first 200 rows for readability.

### Flat File Import Wizard

Right-click a database → **Import Flat File...**, then pick a CSV, TSV, or JSON file. The wizard sniffs a Firebird column type per column (`INTEGER`/`BIGINT`/`NUMERIC`/`BOOLEAN`/`DATE`/`TIMESTAMP`/`VARCHAR`) from the file's own data — optionally with Copilot-assisted type/naming suggestions — and either opens a generated `CREATE TABLE` statement in an editor for you to review/edit before creating a brand-new table, or lets you map the file's columns onto an existing table's instead. Once you confirm, it batch-inserts every row with a progress notification; a large CSV/TSV file is streamed row-by-row rather than read entirely into memory (JSON files are still read fully, a disclosed scope cut).

### SQL Notebooks

Run **New Firebird SQL Notebook** to create a `.fbnb` notebook: mix markdown cells (documentation/notes) with SQL cells. Running a SQL cell (the ▷ button, or `Ctrl+Enter`/`Shift+Enter` like any VS Code notebook) executes every statement in that cell against a connection you pick the first time you run a cell in that notebook — rows come back as a table, DDL/DML as a success message, and errors are shown inline on the cell, all without leaving the notebook. The connection choice is remembered for the rest of that VS Code session, but isn't yet saved into the `.fbnb` file itself, so reopening a notebook (or restarting VS Code) will ask again.

### Data API Builder

Right-click a database → **Generate Data API Spec...** to generate an OpenAPI 3.0 document from the connected schema: a component schema per table (with JSON Schema types inferred from your columns) and CRUD routes (`GET`/`POST /table`, plus `GET`/`PUT`/`DELETE /table/{id}` for tables with a primary key). It opens as plain JSON for you to review — this doesn't run a REST server itself; hand the generated spec to your own backend (or a tool that consumes OpenAPI specs) to actually serve it.

### Database Projects (schema-as-code)

Right-click a database → **Extract Database Project...**, pick a destination folder, and every table, view, procedure, trigger, generator, domain, role, exception, and user is written out as its own `.sql` file, alongside a `firebird.project.json` manifest recording a safe deploy order. Run **Build Database Project...** from the Command Palette and pick that folder to concatenate it back into one script, opened for review — nothing runs automatically; run the script yourself once you're happy with it.

**Publish** compares a project folder against a live connection and generates only the `CREATE`/`ALTER`/`DROP` statements needed to bring it in line — column add/drop/type/default/not-null changes, new foreign keys, generators, and procedures included, again opened for review rather than run automatically. **Generate Migration Script...** does the same comparison between two saved connections directly (no project folder needed) when you just want to diff two databases.

A `NUMERIC`/`DECIMAL` column's precision/scale can be lost in the extract/build round trip (see the design doc for why) — Publish's direct schema comparison isn't affected by this.

### Creating, Renaming, and Dropping Whole Databases

Run **Create New Database...** from the Command Palette to walk through the same connection wizard used for **Add New Connection**, except it also creates the database file itself before adding it as a saved connection. From a database's right-click menu: **Rename Database...** renames its file on disk (embedded connections only — a network connection's file lives on the remote server, which this extension can't reach) and updates the saved connection to match; **Drop Database...** permanently deletes the database after a modal confirmation — there is no undo, and it also removes the now-dangling saved connection entry.

### Object Search

Right-click a database → **Search Objects...** and start typing to fuzzy-search every table, view, procedure, trigger, generator, and domain in that connection by name, in one list. Pick a result and it jumps straight to what you'd want to do with it: a table or view opens its data in the results grid, a procedure/trigger/domain opens an editable `ALTER` scaffold, and a generator shows its current value.

### Create Local Firebird Container

Run **Create Local Firebird Container...** from the Command Palette — Docker's "Add New Connection" option already detects Firebird containers that are already running; this creates a brand-new one. Pick a Firebird version (5.0/4.0/3.0, or a custom image), a container name, host port, SYSDBA password, database name, and whether its data should be ephemeral or kept in a persistent Docker volume. The extension runs `docker run`, waits for the server to actually accept connections (not just for the port to open), and adds it as a saved connection once it's ready.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `firebird.codeCompletion.keywords` | boolean | `true` | Enable code completion for Firebird reserved words |
| `firebird.codeCompletion.database` | boolean | `true` | Enable code completion for table and field names |
| `firebird.logLevel` | string | `INFO` | Logging level in the output channel (`DEBUG`, `INFO`, `WARN`, `ERROR`) |
| `firebird.maxTablesCount` | number | `10` | Maximum tables shown in the tree (0 = all) |
| `firebird.recordsPerPage` | string | `10` | Records per page in results view (`10`, `25`, `50`, `100`, `All records`) |
| `firebird.mockarooApiKey` | string | *(blank)* | API key for the Mock Data Generator |
| `firebird.useNativeDriver` | boolean | `false` | Use the experimental native Firebird client driver |
| `firebird.isqlPath` | string | *(blank)* | Path to the `isql`/`isql-fb` executable; leave blank to search `PATH` automatically |
| `firebird.gbakPath` | string | *(blank)* | Path to the `gbak` executable used by **Backup Database** / **Restore Database**; leave blank to search `PATH` automatically |
| `firebird.showSystemObjects` | boolean | `false` | Show a **System Tables** folder listing Firebird's built-in `RDB$` system/metadata tables under each database |
| `firebird.dockerPath` | string | *(blank)* | Path to the `docker` executable, used to auto-detect running Firebird containers in **Add New Connection**; leave blank to search `PATH` automatically |
| `firebird.enableConnectionPooling` | boolean | `false` | Keep idle connections alive and reuse them instead of reconnecting per query |
| `firebird.connectionPool.maxSize` | number | `5` | Max idle connections retained per saved connection when pooling is enabled |
| `firebird.connectionPool.idleTimeoutMs` | number | `60000` | How long an idle pooled connection is kept before being closed |
| `firebird.profiler.pollIntervalMs` | number | `3000` | How often the Live Profiler re-polls connection activity while its panel is visible |
| `firebird.shortcuts` | object | `{}` | Keyboard shortcuts for actions inside the **Query Results** webview (edit mode, freeze column, copy as INSERT/IN); see the setting's description for event names and combo syntax |
| `firebird.resultsFontFamily` | string | *(blank)* | Font family for the **Query Results** grid; blank uses the webview's own default font |
| `firebird.resultsFontSize` | number | `0` | Font size (px) for the **Query Results** grid; `0` uses the webview's own default size |
| `firebird.queryResultsLocation` | string | `editor` | Where **Query Results** open — `editor` (an editor group) or `panel` (docked in VS Code's bottom Panel, leaving the editor full width) |
| `firebird.messagesDefaultOpen` | boolean | `false` | Land on the **Messages** tab, rather than the first statement's results, after running a batch |
| `firebird.messagesIncludeTimestamps` | boolean | `true` | Include each statement's clock time when using **Copy All** in the Messages pane |
| `firebird.linting.enabled` | boolean | `true` | Enable SQL linting for Firebird SQL documents |
| `firebird.linting.selectStarWarning` | boolean | `true` | Warn when `SELECT *` is used |
| `firebird.linting.missingWhereWarning` | boolean | `true` | Warn when `UPDATE`/`DELETE` statements are missing a `WHERE` clause |
| `firebird.linting.validateTableNames` | boolean | `true` | Validate table names against the active database schema |
| `firebird.transaction.isolationLevel` | string | *(blank)* | Isolation level for every transaction this extension opens (`READ_COMMITTED_RECORD_VERSION`, `READ_COMMITTED_NO_RECORD_VERSION`, `SNAPSHOT`, `SNAPSHOT_TABLE_STABILITY`); blank uses the driver's own default |
| `firebird.transaction.lockTimeoutSec` | number | `0` | Lock wait timeout in seconds before a blocked query gives up (`0` = wait indefinitely); only honored by the pure-JS driver |
| `firebird.transaction.readOnly` | boolean | `false` | Open every query's transaction as READ ONLY |
| `firebird.transaction.waitMode` | string | *(blank)* | `WAIT` or `NO_WAIT` for a lock conflict; blank uses the driver's default (`WAIT`) |
| `firebird.mcp.enabled` | boolean | `false` | Registers the Firebird MCP Server; only connections with **Toggle MCP Server Exposure** turned on are actually reachable |

## Documentation

| Document | Description |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Step-by-step tutorial for first-time users |
| [docs/connection-setup.md](docs/connection-setup.md) | All connection options including native driver and WireCrypt |
| [docs/sql-snippets.md](docs/sql-snippets.md) | Full reference of all 45 SQL snippets |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, code style, and PR process |
| [ROADMAP.md](ROADMAP.md) | Planned features and improvements |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Disclaimer

This extension is still in early development and may not be suitable for use in active production environments.

## Bug Reports & Feature Requests

Submit a bug report or feature suggestion via the [GitHub Issue Tracker](https://github.com/mariuz/vscode-firebird-studio/issues).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up your development environment and submit changes.

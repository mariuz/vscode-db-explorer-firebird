<h1 align="center">
  <br>
    <img src="https://github.com/mvitlov/vscode-db-explorer-firebird/blob/master/images/icon.png?raw=true" alt="extension-icon" width="200">
  <br>
  DB Explorer for Firebird&reg; databases
  <br>
</h1>
<h3 align="center"> Fork of extension from <a href="https://marketplace.visualstudio.com/items?itemName=marinv.vscode-db-explorer-firebird">  Marin Vitlov </a></h3>
<h4 align="center">Explore and run queries against your Firebird&reg; databases without leaving VS Code.</h4>

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ninoDeme.vscode-db-explorer-firebird-fork.svg) ![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/ninoDeme.vscode-db-explorer-firebird-fork.svg)

This extension allows you to connect directly to your [Firebird&reg; databases](https://firebirdsql.org/), list tables and fields, run queries, display/export results and more.

![banner](https://github.com/ninoDeme/vscode-db-explorer-firebird/blob/master/images/banner.jpg?raw=true)

## Features

### Features added in this fork

- **Table alias** in code completion
- [_Experimental_] Native driver support (required for WireCrypt support)
- Fixed query results and mock data view
- 45 Firebird SQL **code snippets** (type `fb` in any `.sql` file)

### Features in the original version

- [SQL Mock Data Generator](https://github.com/ninoDeme/vscode-db-explorer-firebird/wiki/SQL-Mock-Data-Generator)
- Manage multiple database connections
- List hosts, databases, tables, views, stored procedures, triggers, generators, and domains inside **Explorer View**
- [Firebird Reserved Words](https://firebirdsql.org/refdocs/langrefupd25-reskeywords-full-reswords.html) **Code Completion**
- Table and field names **Code Completion**
- Run Firebird **SQL** queries
- Run **predefined** custom queries
- View results in a **table**
- **Realtime** results filtering and sorting
- Export results to **JSON**, **CSV**, **XSLX** or **PDF** file

## Getting Started

For a detailed step-by-step walkthrough see **[docs/getting-started.md](docs/getting-started.md)**.

Quick start:

1. [Install the extension](https://marketplace.visualstudio.com/items?itemName=marinv.vscode-db-explorer-firebird)
2. Restart VS Code and click the **Firebird flame icon** in the Activity Bar.
3. Click **+** in the DB Explorer title bar to add a connection.
4. Right-click your database and choose **Set Active**, then open a `.sql` file and press `Ctrl+Alt+Q` to run a query.

## Using the Extension

### Add a New Connection

Click the **+** (Add New Connection) icon in the DB Explorer title bar. The Connection Wizard guides you through host, port, database path, username, password, and optional role. Your connection appears in the tree when the wizard completes.

For advanced options (native driver, WireCrypt) see **[docs/connection-setup.md](docs/connection-setup.md)**.

### Explore Database Contents

Expand the database node to see category folders: **Tables**, **Views**, **Stored Procedures**, **Triggers**, **Generators**, and **Domains**. Expand any table to see its columns with data types.

> **Tip:** Right-clicking a tree node shows available actions such as **Select All Records**, **Show Table Info**, or **New Query**.

### Set an Active Database

Before running queries, set an active database:

- Right-click the database node → **Set Active**, or
- Click the Firebird indicator in the status bar (bottom-left) and select a database.

> **Tip:** The **New Query** command sets the selected database active and opens a new SQL document.

### Running SQL Queries

Press `Ctrl+Alt+Q` or right-click the editor → **Run Firebird Query**.
Results appear in a new tab with pagination, sorting, and filtering.

> **Note:** Multiple queries in one document are not currently supported. Select the query you want to run if you have more than one.

### SQL Snippets

Type `fb` in any `.sql` file and pick a snippet from the IntelliSense list. There are 45 snippets covering DML, DDL, PSQL control flow, and common functions.

See the full list in **[docs/sql-snippets.md](docs/sql-snippets.md)**.

### SQL Mock Data Generator

Right-click a table → **Generate Mock Data**. Requires a [Mockaroo API key](https://www.mockaroo.com/users/sign_up). See [wiki](https://github.com/ninoDeme/vscode-db-explorer-firebird/wiki/SQL-Mock-Data-Generator) for details.

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

Submit a bug report or feature suggestion via the [GitHub Issue Tracker](https://github.com/mariuz/vscode-db-explorer-firebird/issues).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up your development environment and submit changes.

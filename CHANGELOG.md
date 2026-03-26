# Change Log

All notable changes to the "vscode-db-explorer-firebird" extension will be documented in this file.

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

- [SQL Mock Data Generator](https://github.com/mvitlov/vscode-db-explorer-firebird/wiki/SQL-Mock-Data-Generator)

## 0.0.1 - 2018-11-14

- Initial release

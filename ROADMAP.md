# Roadmap

This document outlines the planned features and improvements for the **DB Explorer for Firebird Databases** VS Code extension, inspired by [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648).

## Enhanced Object Explorer

- [ ] Expand tree view to include views, stored procedures, triggers, generators/sequences, domains, exceptions, and roles
- [ ] Add schema visualization — right-click a database to see a visual diagram of tables, relationships, and objects
- [ ] Show column types, constraints (primary key, foreign key, not null, unique) inline in the tree view
- [ ] Display system tables and metadata tables with a toggle option

## Intelligent IntelliSense Improvements

- [x] Context-aware code completion that understands the current database schema in real time
- [x] Auto-complete for stored procedure and trigger names and parameters
- [ ] Syntax highlighting improvements for Firebird-specific SQL dialect (PSQL blocks, `EXECUTE BLOCK`, etc.)
- [x] Snippet support for common Firebird DDL/DML patterns (e.g., `CREATE TABLE`, `CREATE PROCEDURE`, `CREATE TRIGGER`)

## AI-Powered Enhancements

- [ ] GitHub Copilot integration for Firebird SQL — contextual AI suggestions tailored to the connected database
- [ ] Natural-language query generation — describe what you want in plain English, get Firebird SQL
- [ ] AI-assisted query optimization and explain plan analysis
- [ ] AI-assisted schema design from sample data

## Query Execution and Results

- [ ] Support for executing multiple queries in a single document (batch execution)
- [ ] Session query history — automatically log and recall previously executed queries
- [ ] Explain and analyze query performance with `SET PLANONLY ON` / `SET PLAN ON` integration
- [ ] Editable result grids — update, insert, and delete rows directly from query results
- [ ] Enhanced export options — export results to CSV, JSON, Excel (XLSX), and PDF

## Connection Management

- [ ] Support for Firebird embedded databases
- [ ] Connection profiles with saved credentials (securely stored via VS Code Secret Storage API)
- [ ] Connection pooling for improved performance on repeated queries
- [ ] Support for Firebird 4.x and 5.x wire protocol and authentication (SRP, ChaCha encryption)
- [ ] Docker container support — connect to Firebird instances running in Docker

## Database Management

- [ ] Create, alter, and drop database objects directly from the UI (tables, views, stored procedures, triggers, generators, domains)
- [ ] Visual table designer for creating and modifying tables
- [ ] Index management — view, create, and drop indexes
- [ ] User and role management — create and manage database users and roles
- [ ] Database backup and restore integration (gbak/nbackup)
- [ ] Database statistics and monitoring (gstat integration)

## Collaboration and Productivity

- [ ] SQL formatting and beautification
- [ ] Diff support for comparing database schemas
- [ ] SQL linting and error detection before execution
- [ ] Bookmarks for frequently used queries
- [ ] Workspace-level database configuration (`.vscode/firebird.json`)

## Documentation and Community

- [ ] Improved extension documentation and wiki
- [ ] Sample databases and tutorials for getting started
- [ ] Contributing guide for community contributors

---

> **Note**: This roadmap is subject to change based on community feedback and contributions. Feature requests and suggestions are welcome via [GitHub Issues](https://github.com/mariuz/vscode-db-explorer-firebird/issues).
>
> Inspired by the features announced in [Microsoft's IDE for PostgreSQL in VS Code](https://techcommunity.microsoft.com/blog/adforpostgresql/announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft/4414648).

# Large result sets: server-side paging and query-level filtering

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql) 1.43.0 — "Implemented query-level filtering for Edit Data across full result sets", i.e. the grid's filter is pushed down into the query rather than applied to the rows already on screen. mssql also treats result-grid state management as a distinct workstream ("Query Results Grid experience (Preview) featuring improved state management", 1.44.0).

## Current state in Firebird Studio

**Everything is client-side, and there is no ceiling.**

- **`selectAllRecordsQuery()` is literally `SELECT * FROM ${tableName};`** (`src/shared/queries.ts:113`) — no `FIRST`, no `SKIP`, no row cap. The tree's "Select All Records" action on a 10-million-row table asks the server for all ten million rows.
- **Every fetched row is serialized into the webview payload.** `ResultView.display()`/`displayBatch()` (`src/result-view/index.ts`) build `tableBody` from the complete result and post it; there is no row limit anywhere on that path.
- **`firebird.recordsPerPage` is not a fetch size.** It is passed straight through into the webview payload (`{ results, recordsPerPage, shortcuts, resultsFontSize, resultsFontFamily }`) and consumed by DataTables as a page *length*. Sorting, filtering, and paging all happen in the webview over rows already in memory.
- **The notebook path already got this right, which shows the shape of the fix**: `NOTEBOOK_RESULT_ROW_CAP` (1000) bounds what `rowsToResultTable()` hands to the notebook renderer, and the export flow was deliberately built to *say* when a result was capped rather than silently exporting a partial file (0.1.98). The main results grid has neither the cap nor the disclosure.
- **Row editing reads back what was fetched**: `RowChange.originalRow` is "the row's values as last fetched", used to target the `UPDATE`/`DELETE`. Any paging design has to keep that identity intact across a page boundary.

The practical failure mode is not subtle: a `SELECT *` against a large table blocks on the driver, then serializes the whole result across the extension-host/webview boundary, then hands it to DataTables. Firebird itself is fine with this — the extension is what falls over.

## Proposed feature

- **A fetch cap with honest disclosure.** A `firebird.maxResultRows` setting (defaulting to something like 10 000, in the spirit of the existing `firebird.maxTablesCount`), applied by appending `FIRST n` to `selectAllRecordsQuery()` and by stopping the row-collection loop for arbitrary user queries. When it trips, the grid must say so — the notebook export work already set the precedent that a truncated result is stated, not silently produced.
- **Server-side paging for the grid.** `FIRST n SKIP m` (or Firebird 3+'s standard `OFFSET … FETCH NEXT …`) driven from the grid's pager, so page 2 is a new query rather than a slice of memory. This only works for a statement the extension can safely wrap — a bare `SELECT`, not a `WITH`-heavy statement, an `EXECUTE BLOCK`, or a DML statement — so the wrappable/non-wrappable decision belongs in `sql-splitter.ts`/`sql-analysis.ts` next to the existing statement classification, and non-wrappable statements keep today's fetch-everything behavior with the cap applied.
- **Query-level filtering and sorting (mssql's actual 1.43 item).** When the grid is bound to a single table — which is precisely the case row editing already requires the user to declare, via the table-name input — a column filter or sort becomes a `WHERE`/`ORDER BY` on the re-issued query, so it filters the whole table rather than the current page. Predicate values must go through the existing parameter-binding path (`src/shared/parameterized-query.ts`) rather than string interpolation; `assertValidIdentifier()` already guards the column-name half.
- **An accurate row count.** Once the grid stops holding every row, "1–100 of ?" needs a separate `SELECT COUNT(*)`, which on a large table is itself expensive. Decide explicitly: count lazily on request, or show "100+" until the user asks. Do not issue a blind `COUNT(*)` alongside every page fetch.

## Risks

- **Row identity across pages.** Row editing targets rows by their fetched values; a re-issued paged query with no stable `ORDER BY` can return different rows for the same page. Paging should force a deterministic order (the primary key when one is known, which the tree already knows how to find) and refuse to page an unordered result rather than quietly risk editing the wrong row.
- **Transaction semantics.** Today's single-fetch result is one consistent read. Paged fetches are separate statements and, depending on `firebird.transaction.isolationLevel`, may not see a consistent snapshot — a row can appear on two pages or none. Worth stating in the UI rather than pretending it is a scrolled window over a stable set.
- **This changes a default.** Capping rows makes some current behavior "worse" (you no longer get all 10M rows in one go). That is the right trade, but it is a user-visible behavior change and needs a CHANGELOG entry that says so plainly.

## Suggested phases

1. **`firebird.maxResultRows` cap + truncation disclosure in the grid.** Smallest change that removes the unbounded case; no protocol or paging work.
2. **Server-side paging** for wrappable single-`SELECT` statements, including the deterministic-order requirement and the row-count decision.
3. **Query-level filter/sort push-down** for the single-table (row-editing) case, reusing `parameterized-query.ts` for values.

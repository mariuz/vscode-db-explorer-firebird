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

## Phase 1 — the row cap and its disclosure (done)

A new `firebird.maxResultRows` setting (integer, default **10 000**, `0` for no limit — the same convention as the existing `firebird.maxTablesCount`). It does two different things in two places, and the difference is worth stating plainly rather than letting the setting name imply more than it delivers:

- **A genuine server-side cap where the extension writes the query.** `selectAllRecordsQuery()` now emits `SELECT FIRST n * FROM t`, so "Select All Records" on a huge table never asks the server for more than `n` rows in the first place. Verified against a live Firebird server, not just unit-tested: five rows inserted, `SELECT FIRST 2 *` returned 2 while the uncapped form returned 5.
- **A display cap for everything else.** For arbitrary user SQL there is no streaming loop to stop — the pure-JS driver hands back a whole result set in a single callback — so by the time the extension sees the rows, the server has already produced all of them. `capRows()` bounds what crosses into the webview, which is the part that actually falls over on a large table, but it saves the server and the driver no work. Anyone reading the setting as "queries stop early" would be wrong, and the code comment on `capRows()` says so.

**The disclosure is the other half, and is not optional.** A trimmed result that looks complete is worse than a slow one. `truncationNote()` (pure, in the webview's `__test__` hook, so it is unit-tested like every other function there) renders *"Showing the first 10000 of 50000 rows — raise or disable the limit with the `firebird.maxResultRows` setting."* above the grid, in both the single-result and batch views. It names the setting so the note is actionable rather than merely informative, and it returns `""` when nothing was dropped so callers can append unconditionally.

`rowCount` deliberately stays the number of rows actually shown, so the grid's own count never disagrees with its contents; `truncatedFrom` is what carries "there were more".

**This changes a default**, as the doc's own Risks section anticipated: a result over 10 000 rows is now trimmed where it previously was not. That is a user-visible behaviour change and has a CHANGELOG entry saying so.

## Phase 2 — server-side paging (done)

A capped result now carries a pager. **Next** is a fresh query with an `OFFSET … ROWS FETCH NEXT … ROWS ONLY` window rather than a slice of rows already in the webview, so the extension never has to hold a large table in memory to let you walk through it.

Every claim about what Firebird accepts was checked against a live 6.0.0 server before being encoded, because the whole feature rests on which statements can safely have a window appended:

```
SELECT ID FROM BIGT OFFSET 10000 ROWS FETCH NEXT 5 ROWS ONLY   -> ids 10001..10005
WITH C AS (SELECT ID FROM BIGT) SELECT ID FROM C ORDER BY ID
  OFFSET 100 ROWS FETCH NEXT 5 ROWS ONLY                       -> ids 101..105
… UNION ALL … OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY             -> applies to the whole union
SELECT FIRST 10 ID FROM BIGT OFFSET 5 ROWS FETCH NEXT 5 …      -> -104 "FIRST/SKIP cannot be
                                                                  used with OFFSET/FETCH or ROWS"
SELECT ID FROM BIGT ROWS 1 TO 3 OFFSET 5 ROWS …                -> -104 token unknown: OFFSET
```

`analyzePaging()` lives in `sql-analysis.ts` beside the existing statement classification, as this doc proposed. It refuses anything but a single top-level `SELECT`/`WITH`, refuses a statement that already limits itself, and gates on Firebird 3 — a failed version probe counts as "cannot", because guessing wrong costs a SQL error in the user's face while guessing conservatively only costs the feature. Keyword scanning masks string literals and comments first and only matches at paren depth zero, so a subquery's own `FIRST`, a window function's `ROWS BETWEEN` frame, and `SELECT 'ORDER BY'` are all left alone. The window is appended **on its own line**, because a statement ending in a `--` comment would otherwise swallow it and quietly return everything.

**The row-count question this doc demanded an explicit answer to: no `COUNT(*)`, ever.** Each page asks for one row more than it shows; whether that row arrives is what "there are more" means. So the grid says *Rows 1–10000 of more*, and only names a total on the last page, where it becomes known for free. A blind count alongside every page fetch would double the cost of paging a large table for information nobody asked for.

**Row order is disclosed, not assumed.** A statement with no top-level `ORDER BY` gets a warning that pages may overlap or skip rows, since Firebird is free to return them in a different order each time. Paging is not *refused* without one, as the Risks section suggested: row editing targets rows by their values rather than by position, so an unstable order cannot edit the wrong row — it can only show a confusing window, which saying so addresses.

Changing page discards nothing silently either: with edits queued, the pager refuses to move and says why. That is checked at click time rather than by disabling the buttons, because `pending` is mutated from eight places and a disabled state that forgets to refresh is worse than none.

### The silent truncation phase 1 left behind

`selectAllRecordsQuery()` emitted `SELECT FIRST 10000 *`, which returns exactly 10 000 rows on a larger table — indistinguishable from a table holding exactly 10 000. `capRows()` saw nothing to trim, so **Select All Records showed no disclosure at all**, which is precisely what phase 1 says must never happen. Those paths now ask for one row more than they display, and the extra row (never shown) is what proves there are more. The note has a second form for it — *"Showing the first 10000 rows — there are more"* — because reporting the probe's count as a total would be a lie.

### A three-week-old regression this uncovered

Building the Playwright spec produced a screenshot showing the pager, the truncation note and the toolbar all rendering correctly above **an entirely empty grid** — no rows, no search box, no export buttons.

The batch view built its DataTable against a panel that was not yet in the document: `buildEditableTable()` initialises via `$("#id")`, an id lookup searches the *document*, and DataTables no-ops on an empty set rather than failing. So since `015d75e` (2026-07-11), **every Run Query rendered an empty grid** — the extension's single most-used feature. The original batch code had the ordering right and said why, in a comment reading "Initialise DataTable after appending to DOM"; extracting the shared helper moved the `append` after the call and dropped the comment with it.

It survived three weeks of test runs because the one spec that could have caught it asserted `expectWebviewText(page, "8675309")` — and the sentinel is in the query text, which the batch tab label shows verbatim. The assertion passed on a grid containing nothing. It now asserts on a grid *cell*, and the init runs against the element rather than an id lookup, so neither half of the mistake can recur quietly.

## Suggested phases

1. ~~**`firebird.maxResultRows` cap + truncation disclosure in the grid.** Smallest change that removes the unbounded case; no protocol or paging work.~~ — **done**, see above.
2. ~~**Server-side paging** for wrappable single-`SELECT` statements, including the deterministic-order requirement and the row-count decision.~~ — **done**, see above.
3. **Query-level filter/sort push-down** for the single-table (row-editing) case, reusing `parameterized-query.ts` for values.

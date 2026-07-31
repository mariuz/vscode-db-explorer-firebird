# Quick Queries (keyboard-bound saved SQL)

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql) (1.44.0) — "Introduced Shortcuts Configuration (Preview), allowing you to create and manage keyboard shortcuts for Quick Queries, the Query Editor, and the Results Grid" — and (1.44.1) — "Added support for selected text in Quick Query shortcuts". mssql's Quick Queries let you save frequently used SQL snippets, bind each to a keyboard shortcut, and choose whether the shortcut executes the query immediately or opens it in the editor for review.

## Current state in Firebird Studio

**Not started**, though two of the three ingredients already exist separately and neither one is connected to a keybinding.

- **`firebird.shortcuts` already exists but is a different feature with a confusingly similar name.** `DEFAULT_SHORTCUTS` (`src/config/config.ts`) mirrors `mssql.shortcuts` and covers six actions *inside the Query Results webview* only (`event.toggleEditing`, `event.addRow`, `event.applyChanges`, `event.toggleFreezeColumn`, `event.copyAsInsert`, `event.copyAsInClause`), handled by the webview's own keydown listener because a `contributes.keybindings` entry can't reach into webview content. Nothing here binds a *saved SQL query* to a key — that's mssql's separate "Quick Queries" tab, which Firebird Studio has no equivalent of.
- **Bookmarks are the closest thing to a saved-query store, and they can't be run.** `BookmarkProvider` (`src/bookmarks/bookmark-provider.ts`) persists named SQL in `context.globalState` with a tree view, but its five commands are `firebird.bookmarks.add`/`.open`/`.delete`/`.rename`/`.refresh` — `.open` only drops the text into a new editor, and the only bookmark keybinding is `ctrl+alt+b` for `.add`. There is no "run this bookmark against the active connection" command at all.
- **Snippets (`contributes.snippets`) are editor text templates**, expanded by prefix while typing — not connection-aware and not executable.
- **The constraint that shapes the design**: VS Code keybindings are declared statically in `package.json`, and users can't create new commands. So "bind an arbitrary saved query to a key" can only be done the way mssql does it — ship a fixed set of generic, numbered commands that users bind themselves in VS Code's own Keyboard Shortcuts editor, each dispatching to the *n*th configured query.

## Proposed feature

- A `firebird.quickQueries` setting: an array of `{ name, sql, action: "run" | "open" }` entries (mssql's own execute-immediately vs open-for-review choice, per entry rather than global).
- A fixed set of `firebird.quickQuery.1` … `firebird.quickQuery.9` commands contributed with titles derived from nothing (the entry's `name` can't reach the keybinding UI) but with `category: "Firebird"` so they're findable in the Keyboard Shortcuts editor. Each looks up its index in `firebird.quickQueries` and either runs the SQL or opens it in an untitled `.sql` editor. Shipping *no* default keybindings is the right call — every plausible combo is already taken, and the whole point is that users pick their own.
- **Execution must go through `runSqlBatch()`** (`src/extension.ts`, the shared runner behind `firebird.runQuery`/`firebird.runCurrentStatement`), not a fresh `Driver.runQuery()` call — that's what gets a Quick Query the same multi-statement splitting, DDL-success notification plus Object Explorer refresh, query-history logging, and `{notify, message, options}` error handling every other run path already has.
- **Selected-text support** (mssql 1.44.1): a `${selectedText}` placeholder in the stored SQL, substituted from the active editor's selection before running — this is what makes a single binding useful, e.g. `SELECT COUNT(*) FROM ${selectedText}` over a highlighted table name. Needs an explicit decision on the empty-selection case: substituting an empty string silently produces broken SQL, so it should refuse with a clear message instead.
- **Reuse the bookmark store rather than adding a second saved-query store.** A `slot?: number` field on the existing bookmark model plus an "Assign to Quick Query Slot" tree action gives management UI, persistence, and rename/delete for free, and avoids the state-drift problem of the same query existing in two places. The `firebird.quickQueries` *setting* is still worth having alongside it for settings-sync/workspace-shared queries — but only one of the two should be the source of truth per slot, with the setting winning if both define one.
- **Skip mssql's Shortcuts Configuration webview.** Once the numbered commands exist, VS Code's built-in Keyboard Shortcuts editor already does the binding half, and the bookmarks tree already does the management half. A custom webview duplicating both is the least valuable part of this feature.

## Suggested phases

1. `firebird.quickQueries` setting + the numbered `firebird.quickQuery.N` commands dispatching through the existing `runSqlBatch()` path, no default keybindings and no new UI — the whole feature in its smallest useful form.
2. `${selectedText}` substitution, including the explicit empty-selection refusal.
3. Bookmark integration: a `slot` on the bookmark model and an "Assign to Quick Query Slot" action in the bookmarks tree, with the setting taking precedence over a bookmark for the same slot.
4. (Only if actually requested) a management webview — see above for why this is deliberately last.

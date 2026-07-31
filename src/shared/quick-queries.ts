/**
 * Quick Queries (docs/roadmap/quick-queries.md) — saved SQL bound to a user-chosen keybinding,
 * mirroring vscode-mssql 1.44.0's own feature of the same name.
 *
 * All of this file is pure: no `vscode` import, no `Driver`, no I/O — it turns the raw
 * `firebird.quickQueries` setting value (which is user-authored JSON, so genuinely arbitrary) into
 * a validated slot list, and applies the `${selectedText}` placeholder. The command registrations
 * in `extension.ts` do the editor/dialog half. Same split as `gbak-options.ts`'s
 * `buildBackupFlags()` and for the same reason — this is the part with real decisions in it, and
 * it's unit-testable without a settings UI.
 *
 * Not to be confused with `DEFAULT_SHORTCUTS` in `src/config/config.ts` — that's the *other*
 * mssql-mirroring feature (`firebird.shortcuts`), covering key combos handled inside the query
 * results webview. This one binds whole saved queries to real VS Code commands.
 */

/**
 * How many `firebird.quickQuery.N` commands `package.json` contributes. A fixed, numbered set is
 * the only shape this feature can take: VS Code keybindings are declared statically and users
 * can't create new commands, so "bind an arbitrary saved query to a key" has to be "bind one of N
 * generic commands, each dispatching to the Nth configured query" — the same approach vscode-mssql
 * uses. Raising this number is a `package.json` change, not a code change.
 */
export const QUICK_QUERY_SLOT_COUNT = 9;

/** Replaced with the active editor's current selection before the query runs. */
export const SELECTED_TEXT_PLACEHOLDER = "${selectedText}";

/** What a slot does when its keybinding fires. */
export type QuickQueryAction = "run" | "open";

export interface QuickQuery {
  name: string;
  sql: string;
  action: QuickQueryAction;
}

/**
 * One entry of the parsed setting. `null` means "this position held something unusable" — kept as
 * a placeholder rather than filtered out, because slot numbers are *positions* that users have
 * bound keys to: silently dropping a malformed entry would shift every later query up one slot and
 * quietly repoint working keybindings at the wrong SQL.
 */
export type QuickQuerySlot = QuickQuery | null;

/** The bookmark fields this module needs, structurally — avoids importing the vscode-dependent `Bookmark`. */
export interface QuickQueryBookmark {
  name: string;
  sql: string;
  slot?: number;
}

/** First line of `sql`, capped, for a slot that didn't get an explicit name. */
function deriveName(sql: string): string {
  const firstLine = sql.trim().split("\n")[0].trim();
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
}

/**
 * Normalizes the raw `firebird.quickQueries` setting into a positional slot list. Anything that
 * isn't an object with usable `sql` text becomes `null` (see `QuickQuerySlot` for why the position
 * is preserved). `name` falls back to the query's own first line; `action` falls back to `"run"`,
 * so the minimal useful entry is just `{"sql": "..."}`.
 *
 * Entries past `QUICK_QUERY_SLOT_COUNT` are parsed but unreachable — there's no command to trigger
 * them. That's deliberate: silently truncating would hide a real authoring mistake, and
 * `resolveQuickQuery()` bounds-checks anyway.
 */
export function parseQuickQueries(raw: unknown): QuickQuerySlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry: any): QuickQuerySlot => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    if (typeof entry.sql !== "string" || entry.sql.trim() === "") {
      return null;
    }
    const name = typeof entry.name === "string" && entry.name.trim() !== ""
      ? entry.name.trim()
      : deriveName(entry.sql);
    return {
      name,
      sql: entry.sql,
      action: entry.action === "open" ? "open" : "run",
    };
  });
}

/** Looks up a **1-based** slot number. Out-of-range or unusable slots return `undefined`. */
export function resolveQuickQuery(slots: QuickQuerySlot[], slot: number): QuickQuery | undefined {
  if (!Number.isInteger(slot) || slot < 1 || slot > slots.length) {
    return undefined;
  }
  return slots[slot - 1] ?? undefined;
}

/**
 * The bookmark assigned to a **1-based** slot, if any. The setting wins over a bookmark for the
 * same slot (callers try `resolveQuickQuery()` first) — a workspace/synced setting is the more
 * deliberate of the two, and one of them has to win. When two bookmarks somehow claim the same
 * slot, the first wins, so the result is at least stable rather than ordering-dependent.
 */
export function findBookmarkForSlot(bookmarks: readonly QuickQueryBookmark[], slot: number): QuickQueryBookmark | undefined {
  if (!Number.isInteger(slot) || slot < 1) {
    return undefined;
  }
  return bookmarks.find(bookmark => bookmark.slot === slot);
}

export type SelectedTextResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/**
 * Substitutes the editor's current selection into `${selectedText}` (vscode-mssql 1.44.1's
 * "support for selected text in Quick Query shortcuts") — this is what makes one binding useful
 * for many tables, e.g. `SELECT COUNT(*) FROM ${selectedText}` over a highlighted table name.
 *
 * A query with no placeholder ignores the selection entirely. A query *with* a placeholder and an
 * empty selection is refused rather than substituted with an empty string, which would silently
 * produce broken SQL (`SELECT COUNT(*) FROM `) and a confusing server-side parse error instead of
 * an explanation.
 *
 * Substitution is `split`/`join`, not `String.replace()`: the replacement is arbitrary user-
 * selected text, and `replace()` would interpret `$&`/`$1`/`` $` `` inside it as replacement
 * patterns and mangle the result.
 */
export function applySelectedText(sql: string, selectedText: string | undefined): SelectedTextResult {
  if (!sql.includes(SELECTED_TEXT_PLACEHOLDER)) {
    return { ok: true, sql };
  }
  const trimmed = (selectedText ?? "").trim();
  if (trimmed === "") {
    return {
      ok: false,
      reason: `This Quick Query uses ${SELECTED_TEXT_PLACEHOLDER}, but nothing is selected in the editor.`,
    };
  }
  return { ok: true, sql: sql.split(SELECTED_TEXT_PLACEHOLDER).join(trimmed) };
}

/**
 * How long completion is willing to wait for the schema, and what it does when it runs out.
 *
 * Adapted from mssql 1.45.0's `mssql.intelliSense.completionTimeoutMilliseconds`, which shipped
 * alongside "improved IntelliSense reliability for larger databases and complex queries". The
 * shape of the problem here is the same: building the schema means two catalogue queries against a
 * live server, and on a large or distant database that is unbounded work sitting between a
 * keystroke and a completion list.
 */

/** The manifest default, repeated here so the fallback cannot drift from what package.json says. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 3000;

/**
 * Validates `firebird.intelliSense.completionTimeoutMs`. A settings value can be anything at all —
 * it comes from a JSON file the user edits — so a non-number, a negative or a NaN falls back to
 * the default rather than reaching `setTimeout()`. Zero is meaningful and preserved: it means
 * "wait as long as it takes", which is the behaviour every release before this one had.
 */
export function resolveCompletionTimeoutMs(configured: unknown): number {
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
    return DEFAULT_COMPLETION_TIMEOUT_MS;
  }
  return Math.floor(configured);
}

/**
 * Resolves to whatever `work` produces, or to `onTimeout()` if it takes longer than `ms`.
 *
 * The slow work is **not** cancelled — it cannot be, since a query already in flight has to be
 * read to completion before its connection is usable again, and abandoning it mid-read is how a
 * pooled connection ends up returning the previous caller's rows. It is left to finish and update
 * the cache, so the completion *after* a slow one is the one that benefits. That is also why the
 * timeout degrades rather than fails: returning keywords beats returning nothing, and the user
 * gets table names on the next keystroke.
 */
export function withTimeout<T>(work: PromiseLike<T>, ms: number, onTimeout: () => T): Promise<T> {
  if (ms <= 0) {
    return Promise.resolve(work);
  }
  return new Promise<T>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    // `unref` where available so a pending completion timer cannot hold the host process open.
    (timer as any).unref?.();
    work.then(
      value => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        // A failed schema build is the same outcome as a slow one from completion's point of
        // view: no tables. The provider below already logs the error where it happens.
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      }
    );
  });
}

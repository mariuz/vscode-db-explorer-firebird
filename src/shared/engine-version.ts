/**
 * Per-connection Firebird engine version, fetched once and remembered.
 *
 * Several features need to know the server's major version — the profiler needs 5+, SQL schemas
 * need 6+ (see docs/roadmap/firebird6-schemas.md) — and the tree asks on every expand. Querying
 * `RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION')` each time would add a round trip to an operation
 * users perform constantly, for a value that cannot change while a connection points at the same
 * server.
 *
 * Cached by connection id rather than globally: one workspace routinely has connections to
 * several servers of different versions, and getting that wrong would mean emitting Firebird 6
 * SQL against a Firebird 5 server, where `RDB$SCHEMA_NAME` is a hard error rather than a
 * degradation.
 */

import { parseEngineMajorVersion } from "./actual-plan";

const ENGINE_VERSION_QUERY = `SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE;`;

const cache = new Map<string, number>();

/** Runs a query against an already-open connection — supplied by the caller so this stays testable. */
export type VersionQueryRunner = (sql: string) => Promise<any[]>;

/**
 * Returns the server's major version, e.g. `6` for "6.0.0".
 *
 * Returns 0 when the version cannot be determined, which every caller must treat as "assume the
 * oldest behaviour": a failure to detect must never enable newer SQL. The failure is swallowed
 * rather than reported — a version probe failing is not itself worth interrupting the user for,
 * and whatever the caller does next will report its own error if it matters.
 *
 * Deliberately free of any `vscode` import (and therefore of the logger, which owns an output
 * channel): `shared/db-tools.ts` runs inside the MCP subprocess, which is a plain Node process,
 * and needs this same probe.
 */
export async function getEngineMajorVersion(
  connectionId: string | undefined,
  runQuery: VersionQueryRunner
): Promise<number> {
  const key = connectionId;
  if (key) {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
  }

  let major = 0;
  try {
    const rows = await runQuery(ENGINE_VERSION_QUERY);
    major = parseEngineMajorVersion(String(rows?.[0]?.V ?? ""));
  } catch {
    return 0;
  }

  // Only a successful probe is remembered. Caching a 0 from a transient failure would pin the
  // connection to legacy behaviour for the rest of the session.
  if (key && major > 0) {
    cache.set(key, major);
  }
  return major;
}

/**
 * Drops a cached version. Call when a connection is edited or removed — the same id can be
 * repointed at a different server, and a stale 6 would then produce SQL the new server rejects.
 */
export function forgetEngineVersion(connectionId: string): void {
  cache.delete(connectionId);
}

/** Test seam: clears everything. */
export function clearEngineVersionCache(): void {
  cache.clear();
}

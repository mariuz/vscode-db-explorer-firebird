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

import { ConnectionOptions } from "../interfaces";
import { parseEngineMajorVersion } from "./actual-plan";
import { logger } from "../logger/logger";

const ENGINE_VERSION_QUERY = `SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE;`;

const cache = new Map<string, number>();

/** Runs a query against an already-open connection — supplied by the caller so this stays testable. */
export type VersionQueryRunner = (sql: string) => Promise<any[]>;

/**
 * Returns the server's major version, e.g. `6` for "6.0.0".
 *
 * Returns 0 when the version cannot be determined, which every caller must treat as "assume the
 * oldest behaviour": a failure to detect must never enable newer SQL. The failure is logged but
 * not surfaced — a version probe failing is not itself worth interrupting the user for, and
 * whatever the caller does next will report its own error if it matters.
 */
export async function getEngineMajorVersion(
  connectionOptions: ConnectionOptions,
  runQuery: VersionQueryRunner
): Promise<number> {
  const key = connectionOptions.id;
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
  } catch (err) {
    logger.debug(`Could not determine the Firebird engine version, assuming pre-6 behaviour: ${err}`);
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

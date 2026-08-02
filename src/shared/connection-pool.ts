import type * as Firebird from 'node-firebird';
import type { Attachment } from 'node-firebird-driver-native';
import type { ClientI } from './driver';
import { ConnectionOptions } from '../interfaces';

export interface ConnectionPoolOptions {
  /** Max idle connections retained per connection id. */
  maxSize: number;
  /** Idle connections older than this (ms) are closed on the next sweep. */
  idleTimeoutMs: number;
}

interface PoolEntry<K> {
  connection: K;
  idleSince: number;
}

/**
 * Wraps a ClientI so that detach() returns the connection to an idle pool (keyed by
 * ConnectionOptions.id) instead of closing it, and createConnection() hands out a pooled
 * connection instead of opening a new one when one is available and still alive.
 *
 * Assumes each distinct logical connection (saved or otherwise) carries a stable, unique `id` —
 * true for every ConnectionOptions persisted via FirebirdTreeDataProvider#addConnection().
 */
/**
 * The bucket an idle connection is filed under.
 *
 * Not the connection id alone. A connection's default schema is applied when the session opens
 * (`isc_dpb_search_path`), so it is a property of the *attachment*, not of the saved definition —
 * and changing it would otherwise hand back an idle connection still attached with the old search
 * path, silently resolving unqualified names in the previous schema until the idle sweeper happened
 * to evict it. Including it in the key means a change starts a new bucket and the stale one ages
 * out on its own.
 */
export function poolKey(connectionOptions: ConnectionOptions): string {
  const schema = connectionOptions.defaultSchema?.trim();
  return schema ? `${connectionOptions.id}\u0000${schema}` : connectionOptions.id;
}

export class PooledClient<K extends Firebird.Database | Attachment> implements ClientI<K> {
  private readonly idle = new Map<string, PoolEntry<K>[]>();
  private readonly keyOf = new Map<K, string>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly inner: ClientI<K>,
    private readonly options: ConnectionPoolOptions
  ) {
    this.sweepTimer = setInterval(() => { void this.evictIdle(); }, Math.max(options.idleTimeoutMs, 1000));
    this.sweepTimer.unref?.();
  }

  /** The wrapped client — lets a caller that needs the real NodeClient/NativeClient instance (e.g. Driver.getQueryPlan()'s native-only API) unwrap past pooling. */
  public unwrap(): ClientI<K> {
    return this.inner;
  }

  public queryPromise<T extends object>(connection: K, sql: string): Promise<T[]> {
    return this.inner.queryPromise(connection, sql);
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<K> {
    const key = poolKey(connectionOptions);
    const bucket = this.idle.get(key);
    while (bucket && bucket.length > 0) {
      const entry = bucket.pop()!;
      if (await this.isAlive(entry.connection)) {
        this.keyOf.set(entry.connection, key);
        return entry.connection;
      }
      await this.forceDetach(entry.connection);
    }
    const connection = await this.inner.createConnection(connectionOptions);
    this.keyOf.set(connection, key);
    return connection;
  }

  public async detach(connection: K): Promise<void> {
    const key = this.keyOf.get(connection);
    if (!key) {
      await this.inner.detach(connection);
      return;
    }
    const bucket = this.idle.get(key) ?? [];
    if (bucket.length >= this.options.maxSize) {
      this.keyOf.delete(connection);
      await this.inner.detach(connection);
      return;
    }
    bucket.push({ connection, idleSince: Date.now() });
    this.idle.set(key, bucket);
  }

  /**
   * Closes idle connections that have been sitting longer than idleTimeoutMs. Runs
   * automatically on a timer; also exposed directly so tests can drive it with a fake clock.
   */
  public async evictIdle(now: number = Date.now()): Promise<void> {
    for (const [key, bucket] of this.idle) {
      const stale = bucket.filter((e) => now - e.idleSince > this.options.idleTimeoutMs);
      if (stale.length === 0) {
        continue;
      }
      this.idle.set(key, bucket.filter((e) => now - e.idleSince <= this.options.idleTimeoutMs));
      await Promise.all(stale.map((e) => this.forceDetach(e.connection)));
    }
  }

  /** Closes every pooled idle connection and stops the sweep timer. */
  public async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const all = [...this.idle.values()].flat();
    this.idle.clear();
    await Promise.all(all.map((e) => this.forceDetach(e.connection)));
  }

  /**
   * Number of currently idle (pooled, not checked out) connections for a given connection. Exposed
   * for testing. Takes the whole options object rather than an id because the pool key is not the
   * id alone — see {@link poolKey}.
   */
  public idleCount(connection: string | ConnectionOptions): number {
    const key = typeof connection === "string" ? connection : poolKey(connection);
    return this.idle.get(key)?.length ?? 0;
  }

  /** Database create/drop bypass pooling entirely — there's no live connection to reuse or return. */
  public createDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.inner.createDatabase) {
      return Promise.reject(new Error("The current driver does not support creating databases."));
    }
    return this.inner.createDatabase(connectionOptions);
  }

  public dropDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.inner.dropDatabase) {
      return Promise.reject(new Error("The current driver does not support dropping databases."));
    }
    return this.inner.dropDatabase(connectionOptions);
  }

  private async isAlive(connection: K): Promise<boolean> {
    const isValidFlag = (connection as unknown as { isValid?: boolean }).isValid;
    if (typeof isValidFlag === 'boolean') {
      return isValidFlag;
    }
    try {
      await this.inner.queryPromise(connection, 'SELECT 1 FROM RDB$DATABASE');
      return true;
    } catch {
      return false;
    }
  }

  private async forceDetach(connection: K): Promise<void> {
    this.keyOf.delete(connection);
    try {
      await this.inner.detach(connection);
    } catch {
      // already gone — nothing to do.
    }
  }
}

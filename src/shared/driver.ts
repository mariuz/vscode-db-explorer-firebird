import {TextDocument, TextEditor, workspace, window, ViewColumn, ExtensionContext, commands} from "vscode";
import * as Firebird from "node-firebird";
import {Global} from "./global";
import {ConnectionOptions, Options} from "../interfaces";
import {logger} from "../logger/logger";
import type { Attachment, Client, ResultSet} from 'node-firebird-driver-native';
import { TransactionIsolation, TransactionOptions as NativeTransactionOptions } from 'node-firebird-driver';
import {simpleCallbackToPromise, getConnectionLabel} from './utils';
import {CredentialStore} from './credential-store';
import {splitStatementsWithOffsets} from './sql-splitter';
import {SourcePosition, positionAt, offsetAt, parseServerPosition, shiftPosition} from './statement-position';
import {extractTableNames as extractTableNamesImpl, buildIndexMetadataQuery, renderIndexMetadataPlan, validateReadOnlyStatement} from './sql-analysis';
import {PooledClient, ConnectionPoolOptions} from './connection-pool';
import {setSearchPathQuery} from './queries';
import {connectionSearchPath} from './schema-support';
import {SshTunnelClient} from './ssh-tunnel';
import {getOptions} from '../config';
import {
  ActualPlanNode, buildActualPlanTree, parseEngineMajorVersion, isProfilerSupported, profilerSchemaPrefix,
  startProfilerSessionQuery, flushProfilerQuery, finishProfilerSessionQuery, profiledStatementIdQuery,
  profilerRecordSourcesQuery, profilerRecordSourceStatsQuery, cleanupProfilerSessionQuery,
} from './actual-plan';
import * as fs from 'fs';
import path = require('path');

/**
 * Driver-agnostic transaction request, built once per runQuery()/runBatch() call from the
 * firebird.transaction.* settings and passed down to whichever client is active. Only the fields
 * actually overridden by settings are populated, so an unset field falls through to the
 * underlying driver's own default rather than this module hard-coding one.
 */
export type TransactionIsolationLevel = Exclude<Options["transactionIsolationLevel"], "">;

export interface TransactionRequestOptions {
  isolation?: TransactionIsolationLevel;
  readOnly?: boolean;
  wait?: boolean;
  /** Lock wait timeout in seconds. Only honored by NodeClient — see toNativeTransactionOptions(). */
  lockTimeoutSec?: number;
}

/** Builds a TransactionRequestOptions from the firebird.transaction.* settings. Exported for unit testing. */
export function buildTransactionOptions(options: Pick<Options,
  "transactionIsolationLevel" | "transactionLockTimeoutSec" | "transactionReadOnly" | "transactionWaitMode"
>): TransactionRequestOptions {
  const txOptions: TransactionRequestOptions = {};
  if (options.transactionIsolationLevel) {
    txOptions.isolation = options.transactionIsolationLevel;
  }
  if (options.transactionReadOnly) {
    txOptions.readOnly = true;
  }
  if (options.transactionWaitMode) {
    txOptions.wait = options.transactionWaitMode === "WAIT";
  }
  if (options.transactionLockTimeoutSec) {
    txOptions.lockTimeoutSec = options.transactionLockTimeoutSec;
  }
  return txOptions;
}

/**
 * Maps our driver-agnostic isolation name to node-firebird's own TPB constants. node-firebird
 * names these confusingly: ISOLATION_READ_UNCOMMITTED is NOT a dirty-read isolation (Firebird has
 * no such thing) — it's read_committed+rec_version, i.e. real "Read Committed (Record Version)".
 * We expose the correct Firebird terminology in settings and translate it here instead.
 */
const NODE_FIREBIRD_ISOLATION_MAP: Record<string, Firebird.Isolation> = {
  READ_COMMITTED_RECORD_VERSION: Firebird.ISOLATION_READ_UNCOMMITTED,
  READ_COMMITTED_NO_RECORD_VERSION: Firebird.ISOLATION_READ_COMMITTED,
  SNAPSHOT: Firebird.ISOLATION_REPEATABLE_READ,
  SNAPSHOT_TABLE_STABILITY: Firebird.ISOLATION_SERIALIZABLE,
};

/** Exported for unit testing. */
export function toNodeFirebirdTransactionOptions(txOptions?: TransactionRequestOptions): Firebird.TransactionOptions {
  if (!txOptions) {
    return {};
  }
  const opts: Firebird.TransactionOptions = {};
  if (txOptions.isolation) {
    opts.isolation = NODE_FIREBIRD_ISOLATION_MAP[txOptions.isolation];
  }
  if (txOptions.readOnly !== undefined) {
    opts.readOnly = txOptions.readOnly;
  }
  if (txOptions.wait !== undefined) {
    opts.wait = txOptions.wait;
  }
  if (txOptions.lockTimeoutSec !== undefined) {
    opts.waitTimeout = txOptions.lockTimeoutSec;
  }
  return opts;
}

const NATIVE_ISOLATION_MAP: Record<string, TransactionIsolation> = {
  READ_COMMITTED_RECORD_VERSION: TransactionIsolation.READ_COMMITTED,
  READ_COMMITTED_NO_RECORD_VERSION: TransactionIsolation.READ_COMMITTED,
  SNAPSHOT: TransactionIsolation.SNAPSHOT,
  SNAPSHOT_TABLE_STABILITY: TransactionIsolation.CONSISTENCY,
};

/**
 * Exported for unit testing. lockTimeoutSec has no equivalent in node-firebird-driver's
 * TransactionOptions (no numeric lock-timeout TPB item, only a wait/no-wait toggle) — it is
 * silently not applied here; only NodeClient can honor it.
 */
export function toNativeTransactionOptions(txOptions?: TransactionRequestOptions): NativeTransactionOptions {
  if (!txOptions) {
    return {};
  }
  const opts: NativeTransactionOptions = {};
  if (txOptions.isolation) {
    opts.isolation = NATIVE_ISOLATION_MAP[txOptions.isolation];
    if (txOptions.isolation === "READ_COMMITTED_RECORD_VERSION") {
      opts.readCommittedMode = "RECORD_VERSION";
    } else if (txOptions.isolation === "READ_COMMITTED_NO_RECORD_VERSION") {
      opts.readCommittedMode = "NO_RECORD_VERSION";
    }
  }
  if (txOptions.readOnly !== undefined) {
    opts.accessMode = txOptions.readOnly ? "READ_ONLY" : "READ_WRITE";
  }
  if (txOptions.wait !== undefined) {
    opts.waitMode = txOptions.wait ? "WAIT" : "NO_WAIT";
  }
  return opts;
}

/** Result of a single SQL statement within a batch run. */
export interface BatchResult {
  /** The SQL statement that was executed. */
  sql: string;
  /** Row data (for SELECT-like statements), or undefined for DDL/DML. */
  rows?: any[];
  /** Human-readable outcome message for DDL/DML statements. */
  message?: string;
  /** Error message, present when the statement failed. */
  error?: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /**
   * When the statement was sent, as epoch milliseconds. Kept alongside `durationMs` because the
   * two answer different questions: the duration says which statement was slow, the clock time
   * says when a 60-statement script reached it — and a messages log without times can answer
   * neither on its own.
   */
  startedAt?: number;
  /**
   * This statement's `[start, end)` offset range within the SQL text that was executed — see
   * src/shared/statement-position.ts for what "the executed text" means and does not mean. Present
   * on every result, failed or not, so a caller can tie any statement in a 60-statement script
   * back to the characters it came from.
   */
  range?: { start: number; end: number };
  /** 1-based line/column of the statement's first character within the executed text. */
  position?: SourcePosition;
  /**
   * Where the failure points, within the executed text — Firebird's own `line N, column M` lifted
   * onto the statement's position, or the statement's start when the server named no position.
   * Only set alongside `error`.
   */
  errorPosition?: SourcePosition;
  /**
   * The same point as `errorPosition`, as an offset into the executed text. Both are kept because
   * both are wanted raw: the webview prints line and column, while editor diagnostics need an
   * offset to hand to `TextDocument.positionAt()` after adding the offset the executed text itself
   * started at.
   */
  errorOffset?: number;
}

/** A single query execution recorded for the session query history. */
export interface HistoryLogEntry {
  sql: string;
  connectionId?: string;
  connectionLabel?: string;
  rowCount?: number;
  durationMs: number;
  error?: string;
}

/**
 * The SQL that `runQuery()`/`runBatch()` fall back to when they are handed no statement text — the
 * active editor's selection, or its whole document — together with the document it came from and
 * the offset it starts at.
 *
 * Exported so that a caller wanting to map results back onto the source (line numbers, editor
 * diagnostics) derives the base offset from *the same rule that chose the text*, rather than
 * reimplementing "selection if there is one, otherwise the whole file" and drifting from it the
 * first time that rule changes. Returns undefined for the cases resolveSqlAndConnection() rejects
 * with its own message, so callers can treat "nothing to map" and "nothing to run" alike.
 */
export function activeEditorSql(): { document: TextDocument; sql: string; baseOffset: number } | undefined {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "sql") {
    return undefined;
  }
  const { document, selection } = editor;
  if (selection.isEmpty) {
    return { document, sql: document.getText(), baseOffset: 0 };
  }
  return {
    document,
    sql: document.getText(selection),
    baseOffset: document.offsetAt(selection.start),
  };
}

export class Driver {

  /**
   * Resolves once `client` has been assigned at least once. extension.ts#activate() calls
   * setClient() without awaiting it (native-driver construction can trigger a slow node-gyp
   * build via firebird.buildNative, which must not block activation) — so `client` can briefly
   * be undefined right after activate() resolves. Anything that needs a guaranteed-ready
   * `client` before activate()'s own caller has had a chance to do other async work first (e.g.
   * a test driving a command immediately after activation) should await this.
   */
  static clientReady: Promise<void> = Promise.resolve();

  static async setClient(
    useNativeDriver: boolean,
    context: ExtensionContext,
    pooling?: ConnectionPoolOptions
  ): Promise<void> {
    CredentialStore.setContext(context);
    await this.shutdown();
    const rawClient: ClientI<any> = useNativeDriver ? new NativeClient(context.extensionUri.fsPath) : new NodeClient();
    const pooledOrRaw: ClientI<any> = pooling ? new PooledClient(rawClient, pooling) : rawClient;
    // Always wraps outermost (even when no connection uses sshTunnel) — createConnection() is a
    // pure passthrough for any ConnectionOptions without one, so this costs nothing when unused.
    this.client = new SshTunnelClient(pooledOrRaw);
  }

  /** Closes any open SSH tunnels and pooled idle connections. Call on extension deactivation. */
  static async shutdown(): Promise<void> {
    if (this.client instanceof SshTunnelClient) {
      await this.client.shutdown();
    } else if (this.client instanceof PooledClient) {
      await this.client.shutdown();
    }
  }

  static client: ClientI<any>;

  /** Unwraps any decorator (SshTunnelClient, PooledClient) to find the real NodeClient/NativeClient instance underneath. */
  private static unwrapClient(client: ClientI<any>): ClientI<any> {
    if (client instanceof SshTunnelClient || client instanceof PooledClient) {
      return this.unwrapClient(client.unwrap());
    }
    return client;
  }

  /** Optional sink for automatic query history logging; wired up once in extension.ts#activate(). */
  static historyLogger?: (entry: HistoryLogEntry) => void;

  public static setHistoryLogger(historyLogger: (entry: HistoryLogEntry) => void): void {
    this.historyLogger = historyLogger;
  }

  /**
   * Records a single executed statement to the session query history (if a logger is
   * registered). Every query run through runQuery()/runBatch() — i.e. every query the user
   * explicitly executes, whether typed or triggered from a tree context-menu action — passes
   * through here. Internal schema-introspection queries (tree population, autocomplete) go
   * through Driver.client directly and are intentionally not logged.
   */
  private static logHistory(
    sql: string,
    connectionOptions: ConnectionOptions | undefined,
    durationMs: number,
    rowCount?: number,
    error?: string
  ): void {
    if (!this.historyLogger) {
      return;
    }
    this.historyLogger({
      sql,
      connectionId: connectionOptions?.id,
      connectionLabel: connectionOptions ? getConnectionLabel(connectionOptions) : undefined,
      rowCount,
      durationMs,
      error,
    });
  }

  public static async createSQLTextDocument(sql?: string): Promise<TextEditor> {
    const textDocument = await workspace.openTextDocument({content: sql, language: "sql"});
    return window.showTextDocument(textDocument, ViewColumn.One);
  }

  public static constructResponse(sql: string): string | null {
    const string = sql.toLowerCase();
    if (string.indexOf("create") > -1) {
      return "Create";
    } else if (string.indexOf("insert") > -1) {
      return "Insert";
    } else if (string.indexOf("alter") > -1) {
      return "Alter";
    } else if (string.indexOf("drop") > -1) {
      return "Drop";
    } else if (string.indexOf("delete") > -1) {
      return "Delete";
    }
    return null;
  }

  /**
   * Resolves the password for a connection, fetching from SecretStorage if not already set.
   * Public because runQuery()/runBatch() call it automatically, but any code that connects via
   * Driver.client.createConnection() directly (bypassing those) must call it explicitly first —
   * saved connections never carry a password (see FirebirdTreeDataProvider#addConnection), so
   * skipping this fails with "Your user name and password are not defined".
   */
  public static async resolvePassword(connectionOptions: ConnectionOptions): Promise<ConnectionOptions> {
    if (connectionOptions.password) {
      return connectionOptions;
    }
    const stored = await CredentialStore.getPassword(connectionOptions.id);
    return { ...connectionOptions, password: stored ?? "" };
  }

  public static async runQuery(sql?: string, connectionOptions?: ConnectionOptions, params?: any[]): Promise<any> {
    logger.debug("Run Query start...");

    if (!sql && !window.activeTextEditor) {
      return Promise.reject({
        notify: true,
        message: "No SQL document opened!",
        options: ["Cancel", "New SQL Document"]
      });
    }
    if (!sql && window.activeTextEditor) {
      if (window.activeTextEditor.document.languageId !== "sql") {
        return Promise.reject({
          notify: true,
          message: "No SQL document opened!",
          options: ["Cancel", "New SQL Document"]
        });
      }
    }
    if (!connectionOptions) {
      if (!Global.activeConnection) {
        return Promise.reject({
          notify: true,
          message: "No Firebird database selected!",
          options: ["Cancel", "Set Active Database"]
        });
      }
    }

    // finally check if empty sql document
    if (!sql) {
      const activeTextEditor = window.activeTextEditor;
      const selection = activeTextEditor!.selection;
      if (selection.isEmpty) {
        sql = activeTextEditor!.document.getText();
      } else {
        sql = activeTextEditor!.document.getText(selection);
      }
      if (!sql) {
        return Promise.reject({notify: false, message: "No valid SQL commands found!"});
      }
    }

    connectionOptions = connectionOptions ? connectionOptions : Global.activeConnection;
    connectionOptions = await this.resolvePassword(connectionOptions);

    logger.info("Executing Firebird query...");

    const start = Date.now();
    let connection;
    try {
      connection = await this.client.createConnection(connectionOptions);
    } catch (err: any) {
      Global.reportConnectionOutcome(connectionOptions.id, err);
      throw err;
    }
    const txOptions = buildTransactionOptions(getOptions());
    try {
      const result = await this.client.queryPromise(connection, sql, params, txOptions);
      Global.reportConnectionOutcome(connectionOptions.id, undefined);
      const durationMs = Date.now() - start;

      if (result !== undefined) {
        //convert blob
        result.forEach(resultRow => {
          const row = resultRow as Record<string, any>;
          Object.keys(row).forEach(field => {
            if (row[field] instanceof Function) {
              row[field]((_err: any, _name: any, e: any) => {
                e.on("data", (chunk: any) => {
                  row[field] = chunk;
                });
              });
            }
          });
        });
        logger.info("Finished Firebird query, displaying results... ");
        this.logHistory(sql, connectionOptions, durationMs, result.length);
        return result;
      } else {
        // because node-firebird plugin doesn't have callback on successfull ddl statements (test further)
        logger.info("Finished Firebird query.");
        const ddl = this.constructResponse(sql);
        this.logHistory(sql, connectionOptions, durationMs);
        return ([{message: `${ddl} command executed successfully!`}]);
      }
    } catch (err: any) {
      Global.reportConnectionOutcome(connectionOptions.id, err);
      this.logHistory(sql, connectionOptions, Date.now() - start, undefined, err?.message ?? String(err));
      throw err;
    } finally {
      this.client.detach(connection);
    }
  }

  /**
   * Resolves SQL text from the active editor (or the provided string), validates the active
   * connection, and returns `{ sql, connectionOptions }` ready for execution.
   */
  private static async resolveSqlAndConnection(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<{ sql: string; connectionOptions: ConnectionOptions }> {
    if (!sql && !window.activeTextEditor) {
      throw { notify: true, message: "No SQL document opened!", options: ["Cancel", "New SQL Document"] };
    }
    if (!sql && window.activeTextEditor && window.activeTextEditor.document.languageId !== "sql") {
      throw { notify: true, message: "No SQL document opened!", options: ["Cancel", "New SQL Document"] };
    }
    if (!connectionOptions && !Global.activeConnection) {
      throw { notify: true, message: "No Firebird database selected!", options: ["Cancel", "Set Active Database"] };
    }
    if (!sql) {
      sql = activeEditorSql()?.sql;
      if (!sql) {
        throw { notify: false, message: "No valid SQL commands found!" };
      }
    }
    connectionOptions = connectionOptions ?? Global.activeConnection;
    connectionOptions = await this.resolvePassword(connectionOptions);
    return { sql, connectionOptions };
  }

  /**
   * Executes all semicolon-separated statements in the given SQL text and returns an array of
   * `BatchResult` objects — one per statement.
   */
  public static async runBatch(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<BatchResult[]> {
    logger.debug("runBatch start...");

    const resolved = await this.resolveSqlAndConnection(sql, connectionOptions);
    // …WithOffsets rather than the text-only split: every result carries where its statement sat
    // in the text, which is what lets a failure on statement 40 of 60 name a line instead of
    // leaving the user to count semicolons.
    const statements = splitStatementsWithOffsets(resolved.sql);

    if (statements.length === 0) {
      throw { notify: false, message: "No valid SQL commands found!" };
    }

    logger.info(`Batch: executing ${statements.length} statement(s)...`);

    let connection;
    try {
      connection = await this.client.createConnection(resolved.connectionOptions);
    } catch (err: any) {
      Global.reportConnectionOutcome(resolved.connectionOptions.id, err);
      throw err;
    }
    const txOptions = buildTransactionOptions(getOptions());
    const results: BatchResult[] = [];

    try {
      for (const statement of statements) {
        const stmt = statement.text;
        const range = { start: statement.start, end: statement.end };
        const position = positionAt(resolved.sql, statement.start);
        const start = Date.now();
        try {
          const rows = await this.client.queryPromise(connection, stmt, undefined, txOptions);
          Global.reportConnectionOutcome(resolved.connectionOptions.id, undefined);
          const durationMs = Date.now() - start;

          if (rows !== undefined) {
            // Convert blobs
            rows.forEach(row => {
              const r = row as Record<string, any>;
              Object.keys(r).forEach(field => {
                if (r[field] instanceof Function) {
                  r[field]((_err: any, _name: any, e: any) => {
                    e.on("data", (chunk: any) => { r[field] = chunk; });
                  });
                }
              });
            });
            results.push({ sql: stmt, rows, durationMs, startedAt: start, range, position });
            this.logHistory(stmt, resolved.connectionOptions, durationMs, rows.length);
          } else {
            const ddl = this.constructResponse(stmt);
            results.push({
              sql: stmt,
              message: `${ddl ?? "Statement"} executed successfully.`,
              durationMs,
              startedAt: start,
              range,
              position,
            });
            this.logHistory(stmt, resolved.connectionOptions, durationMs);
          }
        } catch (err: any) {
          Global.reportConnectionOutcome(resolved.connectionOptions.id, err);
          const durationMs = Date.now() - start;
          const message = err?.message ?? String(err);
          // The server counts from the start of the statement it was given, not from the start of
          // the script — each statement is prepared on its own — so its position has to be lifted
          // onto the statement's own before it means anything to the user.
          const within = parseServerPosition(message);
          const errorPosition = within ? shiftPosition(position, within) : position;
          const errorOffset = within ? statement.start + offsetAt(stmt, within) : statement.start;
          results.push({ sql: stmt, error: message, durationMs, startedAt: start, range, position, errorPosition, errorOffset });
          logger.error(`Batch statement failed at line ${errorPosition.line}: ${message}`);
          this.logHistory(stmt, resolved.connectionOptions, durationMs, undefined, err?.message ?? String(err));
        }
      }
    } finally {
      this.client.detach(connection);
    }

    logger.info(`Batch completed. ${results.length} result(s) ready.`);
    return results;
  }

  /**
   * Returns the Firebird query execution plan for the given SELECT statement.
   *
   * - NativeClient: uses `Attachment.prepare()` + `Statement.getPlan()`.
   * - NodeClient:   falls back to querying index metadata from system tables.
   */
  public static async getQueryPlan(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<string> {
    const resolved = await this.resolveSqlAndConnection(sql, connectionOptions);
    const stmt = resolved.sql;

    const rawClient = this.unwrapClient(this.client);
    if (rawClient instanceof NativeClient) {
      const connectionOptions = this.client instanceof SshTunnelClient
        ? await this.client.resolveConnectionOptions(resolved.connectionOptions)
        : resolved.connectionOptions;
      return rawClient.getQueryPlan(connectionOptions, stmt);
    }

    // NodeClient fallback: extract table names and show index metadata (see sql-analysis.ts —
    // shared with src/mcp-server/server.ts's get_query_plan tool, which can't import this file).
    const tables = extractTableNamesImpl(stmt);
    if (tables.length === 0) {
      return renderIndexMetadataPlan(stmt, tables, []);
    }

    const metaSql = buildIndexMetadataQuery(tables);
    const connection = await this.client.createConnection(resolved.connectionOptions);
    try {
      const rows: any[] = await (this.client as NodeClient).queryPromise(connection, metaSql, tables);
      return renderIndexMetadataPlan(stmt, tables, rows);
    } finally {
      this.client.detach(connection);
    }
  }

  /**
   * "Actual Plan" (docs/roadmap/query-plan-visualizer.md phase 3) — per-node execution stats via
   * Firebird 5.0+'s `RDB$PROFILER` package (see `actual-plan.ts`'s header comment for the full
   * session-lifecycle reasoning, verified against a live server). Unlike getQueryPlan(), this
   * doesn't just prepare the statement — it actually executes and fully fetches it, so it's
   * restricted to a single read-only SELECT the same way the MCP server's run_query tool is
   * (`validateReadOnlyStatement()`), and works identically over the native or pure-JS driver
   * since it's plain SQL against the profiler's own tables, not a native-only API.
   */
  public static async getActualPlan(
    sql?: string,
    connectionOptions?: ConnectionOptions
  ): Promise<ActualPlanNode[]> {
    const resolved = await this.resolveSqlAndConnection(sql, connectionOptions);
    const stmt = resolved.sql;

    const readOnlyError = validateReadOnlyStatement(stmt);
    if (readOnlyError) {
      throw new Error(`Actual Plan re-executes the query to collect real stats, so it only supports a single read-only SELECT: ${readOnlyError}`);
    }

    const connection = await this.client.createConnection(resolved.connectionOptions);
    try {
      const versionRows: any[] = await this.client.queryPromise(
        connection, `SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS V FROM RDB$DATABASE;`
      );
      const majorVersion = parseEngineMajorVersion(String(versionRows[0]?.V ?? ""));
      if (!isProfilerSupported(majorVersion)) {
        throw new Error("Actual Plan requires Firebird 5.0 or newer — the RDB$PROFILER package isn't available on this server.");
      }
      const schemaPrefix = profilerSchemaPrefix(majorVersion);

      const sessionRows: any[] = await this.client.queryPromise(
        connection, startProfilerSessionQuery(`Firebird Studio Actual Plan - ${new Date().toISOString()}`)
      );
      const profileId = Number(sessionRows[0]?.PROFILE_ID);
      if (!Number.isInteger(profileId)) {
        throw new Error("Could not start a profiler session.");
      }

      try {
        await this.client.queryPromise(connection, stmt);
        await this.client.queryPromise(connection, flushProfilerQuery);
        // Must stop the session before any of the diagnostic queries below run — see
        // finishProfilerSessionQuery's doc comment for why (they'd otherwise profile themselves).
        await this.client.queryPromise(connection, finishProfilerSessionQuery);

        const stmtIdRows: any[] = await this.client.queryPromise(
          connection, profiledStatementIdQuery(schemaPrefix, profileId, stmt)
        );
        const statementId = Number(stmtIdRows[0]?.STATEMENT_ID);
        if (!Number.isInteger(statementId)) {
          throw new Error("Could not identify the profiled statement.");
        }

        // Sequential, not Promise.all: both queries run over the same physical connection, and
        // node-firebird's single request/response socket can hang indefinitely if two
        // transaction()+query() cycles are interleaved concurrently on it (reproduced reliably
        // inside a real Extension Development Host, though not in a plain Node process — the
        // concurrent pattern was never actually safe, just inconsistently timed).
        const recordSources = await this.client.queryPromise(connection, profilerRecordSourcesQuery(schemaPrefix, profileId, statementId));
        const stats = await this.client.queryPromise(connection, profilerRecordSourceStatsQuery(schemaPrefix, profileId, statementId));

        return buildActualPlanTree(recordSources as any, stats as any);
      } finally {
        // Best-effort: RDB$PROFILER.CANCEL_SESSION alone doesn't delete already-flushed rows, so
        // without this the PLG$PROF_* tables would grow forever in the user's own database. Not
        // worth failing the whole request over — the data we needed has already been returned.
        await this.client.queryPromise(connection, cleanupProfilerSessionQuery(schemaPrefix, profileId))
          .catch(err => logger.error(`Actual Plan cleanup failed: ${err?.message ?? err}`));
      }
    } finally {
      this.client.detach(connection);
    }
  }

  /** Creates a brand-new, empty database file/attachment from connection options (host/port or embedded path). */
  public static async createDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.client.createDatabase) {
      throw new Error("The current driver does not support creating databases.");
    }
    return this.client.createDatabase(connectionOptions);
  }

  /** Permanently deletes a database — there is no undo. */
  public static async dropDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (!this.client.dropDatabase) {
      throw new Error("The current driver does not support dropping databases.");
    }
    return this.client.dropDatabase(connectionOptions);
  }

}

export interface ClientI<K extends Firebird.Database | Attachment> {
  queryPromise<T extends object>(connection: K, sql: string, args?: any[], txOptions?: TransactionRequestOptions): Promise<T[]>;
  createConnection(connectionOptions: ConnectionOptions): Promise<K>;
  detach(connection: K): Promise<void>;
  /** Optional: fake/test ClientI implementations that never exercise create/drop can omit these. */
  createDatabase?(connectionOptions: ConnectionOptions): Promise<void>;
  dropDatabase?(connectionOptions: ConnectionOptions): Promise<void>;
}

/**
 * Maps our ConnectionOptions to a node-firebird Options object, handling embedded and
 * Firebird 4.x/5.x fields. Exported for unit testing.
 */
export function toNodeFirebirdOptions(connectionOptions: ConnectionOptions): Firebird.Options {
  const opts: Firebird.Options = {
    database: connectionOptions.database,
    user: connectionOptions.user,
    password: connectionOptions.password ?? "",
    role: connectionOptions.role ?? undefined
  };

  if (!connectionOptions.embedded) {
    opts.host = connectionOptions.host;
    opts.port = connectionOptions.port ?? 3050;
  }

  if (connectionOptions.wireCrypt) {
    // node-firebird's Options.wireCrypt is the numeric WIRE_CRYPT_DISABLE/WIRE_CRYPT_ENABLE
    // constant (written directly into the wire protocol handshake), not our UI-facing
    // 'Required' | 'Enabled' | 'Disabled' string — node-firebird has no separate
    // "required" wire value, so anything but 'Disabled' maps to WIRE_CRYPT_ENABLE.
    opts.wireCrypt = connectionOptions.wireCrypt === 'Disabled' ? Firebird.WIRE_CRYPT_DISABLE : Firebird.WIRE_CRYPT_ENABLE;
  }
  if (connectionOptions.authPlugin) {
    (opts as any).authPlugin = connectionOptions.authPlugin;
  }
  // Firebird 6 SQL schemas. node-firebird sends this as isc_dpb_search_path only when the
  // negotiated protocol is 20+, so passing it to an older server is inert rather than an error —
  // no version probe is needed before attaching.
  const defaultSchema = connectionOptions.defaultSchema?.trim();
  if (defaultSchema) {
    (opts as any).defaultSchema = defaultSchema;
  }

  return opts;
}

export class NodeClient implements ClientI<Firebird.Database> {
  /**
   * Runs `sql` in its own transaction, built manually (rather than the simpler `connection.query()`)
   * so firebird.transaction.* settings can be applied — `Database.query()`/`execute()` always call
   * `startTransaction()` with no options, hard-coding the driver's defaults.
   */
  public queryPromise<T>(connection: Firebird.Database, sql: string, args: any[] = [], txOptions?: TransactionRequestOptions): Promise<T[]> {
    return new Promise((resolve, reject) => {
      connection.transaction(toNodeFirebirdTransactionOptions(txOptions), (txErr: any, transaction: Firebird.Transaction) => {
        if (txErr) {
          reject("Error queryPromise: " + txErr.message);
          return;
        }
        transaction.query(sql, args, (err: any, rows: any) => {
          if (err) {
            transaction.rollback(() => reject("Error queryPromise: " + err.message));
            return;
          }
          transaction.commit((commitErr: any) => {
            if (commitErr) {
              reject("Error queryPromise: " + commitErr.message);
              return;
            }
            resolve(rows);
          });
        });
      });
    });
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<Firebird.Database> {
    if (connectionOptions.embedded) {
      // node-firebird only ever speaks the wire protocol over TCP — it has no embedded-engine
      // support, so without host/port it would silently fall back to 127.0.0.1:3050 instead of
      // opening the local file directly. Fail loudly rather than connecting to the wrong thing.
      throw new Error(
        "Embedded database connections require the native driver. Enable \"firebird.useNativeDriver\" in settings to connect to this database."
      );
    }
    const opts = toNodeFirebirdOptions(connectionOptions);
    return await new Promise<Firebird.Database>((resolve, reject) => {
      Firebird.attach(opts, (err, db) => {
        if (err) {
          logger.error(err.message);
          reject(err);
        }

        resolve(db);
      });
    });
  }

  public async detach(connection: Firebird.Database) {
    if (connection) {
      await simpleCallbackToPromise((callback) => connection.detach(callback));
    }
  }

  public async createDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (connectionOptions.embedded) {
      throw new Error(
        "Embedded database creation requires the native driver. Enable \"firebird.useNativeDriver\" in settings."
      );
    }
    const opts = toNodeFirebirdOptions(connectionOptions);
    return new Promise((resolve, reject) => {
      Firebird.create(opts, (err: any, db: Firebird.Database) => {
        if (err) {
          reject(err);
          return;
        }
        db.detach(() => resolve());
      });
    });
  }

  public async dropDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    if (connectionOptions.embedded) {
      throw new Error(
        "Embedded database drop requires the native driver. Enable \"firebird.useNativeDriver\" in settings."
      );
    }
    const opts = toNodeFirebirdOptions(connectionOptions);
    return new Promise((resolve, reject) => {
      Firebird.drop(opts, (err: any) => {
        if (err) {
          reject(new Error(err?.error?.message ?? err?.message ?? String(err)));
          return;
        }
        resolve();
      });
    });
  }
}

export class NativeClient implements ClientI<Attachment> {

  constructor(pathExt: string) {
    if (!fs.existsSync(path.join(pathExt, 'node_modules/node-firebird-native-api/build/Release'))) {
      commands.executeCommand("firebird.buildNative");
    }
  }

  public async queryPromise<T extends object>(connection: Attachment, sql: string, args?: any[], txOptions?: TransactionRequestOptions): Promise<T[]> {
    if (!connection?.isValid) {
      throw new Error("Invalid Connection");
    }
    const trans = await connection.startTransaction(toNativeTransactionOptions(txOptions));
    let res: ResultSet | undefined;
    try {
      res = await connection.executeQuery(trans, sql, args);
      const result = await res.fetchAsObject<T>();
      await res.close();
      await trans.commit();
      return result;  
    } catch (err) {
      if (res?.isValid) {
        await res.close();
      }
      if (trans.isValid) {
        await trans.rollback();
      }
      throw err;
    }
  }

  public async createConnection(connectionOptions: ConnectionOptions): Promise<Attachment> {
    const connectionStr = connectionOptions.embedded
      ? connectionOptions.database
      : `${connectionOptions.host}/${connectionOptions.port ?? '3050'}:${connectionOptions.database}`;

    let client: Client;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {createNativeClient, getDefaultLibraryFilename} = await import('node-firebird-driver-native');
      client = createNativeClient(getDefaultLibraryFilename());  
    } catch (e) {
      throw new Error("Unable to initialize native driver: " + ((e as any)?.message ?? e));
    }

    const attachment = await client.connect(connectionStr, {
      username: connectionOptions.user,
      password: connectionOptions.password ?? "",
      role: connectionOptions.role ?? undefined
    });

    // The native driver's ConnectOptions has no search-path field, so the schema cannot ride along
    // with the attach the way it does on the pure-JS driver. Setting it as the session's first
    // statement reaches the same end state — the search path is attachment-scoped either way — at
    // the cost of one extra round trip, and only when a schema is actually configured.
    //
    // It must send the *whole* path connectionSearchPath() describes, not just the configured
    // schema: node-firebird keeps PUBLIC behind it as a fallback, so sending `SET SEARCH_PATH TO
    // SALES` alone would leave the native driver unable to resolve an unqualified PUBLIC table that
    // the pure-JS driver resolves fine — the same saved connection behaving differently depending
    // on a setting that is meant to be a performance choice.
    //
    // Requested upstream: asfernandes/node-firebird-drivers#172. If ConnectOptions gains a
    // searchPath option, this block becomes one more field in the connect() call above.
    const searchPath = connectionSearchPath(connectionOptions.defaultSchema);
    if (searchPath.length) {
      try {
        await this.queryPromise(attachment, setSearchPathQuery(searchPath));
      } catch (err: any) {
        // A pre-6 server rejects the statement outright. That is not a reason to fail the
        // connection: the pure-JS driver silently ignores the same setting on such a server, and
        // the two drivers should not disagree about whether a connection can be opened at all.
        logger.debug(`Could not apply search path "${searchPath.join(", ")}": ${err?.message ?? err}`);
      }
    }
    return attachment;
  }

  public async detach(connection: Attachment) {
    if (connection.isValid) {
      await connection.disconnect();
    } else {
      logger.debug("Called detach on an invalid connection");
    }
  }

  public async createDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    const connectionStr = connectionOptions.embedded
      ? connectionOptions.database
      : `${connectionOptions.host}/${connectionOptions.port ?? '3050'}:${connectionOptions.database}`;

    let client: Client;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {createNativeClient, getDefaultLibraryFilename} = await import('node-firebird-driver-native');
      client = createNativeClient(getDefaultLibraryFilename());
    } catch (e) {
      throw new Error("Unable to initialize native driver: " + ((e as any)?.message ?? e));
    }

    const attachment = await client.createDatabase(connectionStr, {
      username: connectionOptions.user,
      password: connectionOptions.password ?? "",
      role: connectionOptions.role ?? undefined
    });
    await attachment.disconnect();
  }

  public async dropDatabase(connectionOptions: ConnectionOptions): Promise<void> {
    const connection = await this.createConnection(connectionOptions);
    await connection.dropDatabase();
  }

  /**
   * Returns the Firebird execution plan for a single SELECT statement using the native driver's
   * `prepare()` + `Statement.getPlan()` API.
   */
  public async getQueryPlan(connectionOptions: ConnectionOptions, sql: string): Promise<string> {
    const connection = await this.createConnection(connectionOptions);
    try {
      const trans = await connection.startTransaction();
      try {
        const stmt = await connection.prepare(trans, sql) as any;
        const plan = await stmt.getPlan(false);
        await stmt.free();
        await trans.rollback();
        return plan ?? `-- No plan returned by Firebird for:\n${sql}`;
      } catch (err: any) {
        await trans.rollback().catch(() => {});
        throw err;
      }
    } finally {
      if (connection.isValid) {
        await connection.disconnect();
      }
    }
  }
}

/**
 * Re-exported from sql-analysis.ts (moved there so src/mcp-server/server.ts — a separate spawned
 * subprocess that cannot import this file at all, since it pulls in `vscode` — can share the exact
 * same heuristic rather than a second, drifting copy). Existing imports of `extractTableNames`
 * from `./driver` keep working unchanged.
 */
export { extractTableNames } from "./sql-analysis";
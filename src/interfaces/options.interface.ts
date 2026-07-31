import { QuickQuerySlot } from "../shared/quick-queries";

export interface Options {
  mockarooApiKey: string | null;
  maxTablesCount: number;
  codeCompletionKeywords: boolean;
  codeCompletionDatabase: boolean;
  logLevel: string;
  recordsPerPage: string;
  useNativeDriver: boolean;
  /** Explicit path to the isql/isql-fb executable; empty string means "search PATH". */
  isqlPath: string;
  /** Explicit path to the gbak executable (used by Backup/Restore Database); empty string means "search PATH". */
  gbakPath: string;
  /** Show a "System Tables" folder listing Firebird's built-in RDB$ system/metadata tables. */
  showSystemObjects: boolean;
  /** Explicit path to the docker executable; empty string means "search PATH". */
  dockerPath: string;
  /** When true, idle connections are kept alive and reused instead of reconnecting per query. */
  enableConnectionPooling: boolean;
  /** Max idle connections retained per saved connection when pooling is enabled. */
  connectionPoolMaxSize: number;
  /** How long (ms) an idle pooled connection is kept before being closed. */
  connectionPoolIdleTimeoutMs: number;
  /** How often (ms) the Live Profiler polls MON$ activity while its panel is visible. */
  profilerPollIntervalMs: number;
  /** Query-results webview key combos (event name -> combo string), overriding `DEFAULT_SHORTCUTS`. */
  shortcuts: Record<string, string>;
  /**
   * Transaction isolation level applied to every query/batch this extension runs.
   * `''` means "use the driver's own default" (Read Committed, No Record Version).
   */
  transactionIsolationLevel: '' | 'READ_COMMITTED_RECORD_VERSION' | 'READ_COMMITTED_NO_RECORD_VERSION' | 'SNAPSHOT' | 'SNAPSHOT_TABLE_STABILITY';
  /** Lock wait timeout in seconds (`0` = wait indefinitely). Only honored by the pure-JS driver. */
  transactionLockTimeoutSec: number;
  /** Opens every query's transaction as READ ONLY. */
  transactionReadOnly: boolean;
  /** Whether a lock conflict waits or fails immediately. `''` means "use the driver's default (WAIT)". */
  transactionWaitMode: '' | 'WAIT' | 'NO_WAIT';
  /** Registers the firebird-mcp MCP server, exposing whichever connections have opted in (ConnectionOptions.mcpExposed) as read-only schema-inspection tools to MCP clients. Off by default. */
  mcpEnabled: boolean;
  /** Query results grid font size in px. `0` means "use the webview's own default". */
  resultsFontSize: number;
  /** Query results grid font family (CSS font-family value). `''` means "use the webview's own default". */
  resultsFontFamily: string;
  /**
   * Quick Queries — saved SQL dispatched by the `firebird.quickQuery.N` commands, by position.
   * Already validated by `parseQuickQueries()`; a `null` entry is a slot whose configured value
   * was unusable (kept so later slots don't shift — see `QuickQuerySlot`).
   */
  quickQueries: QuickQuerySlot[];
}

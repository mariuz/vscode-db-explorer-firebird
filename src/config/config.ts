import { workspace, WorkspaceConfiguration } from "vscode";
import { Options } from "../interfaces";
import { Level, logger } from "../logger/logger";
import { parseQuickQueries, QuickQuerySlot } from "../shared/quick-queries";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const properties = require("../../package.json").contributes.configuration.properties;

export function getOptions() {
  return {
    mockarooApiKey: _mockarooApiKey(),
    maxTablesCount: _maxTablesCount(),
    maxResultRows: _maxResultRows(),
    codeCompletionKeywords: _codeCompletionKeywords(),
    codeCompletionDatabase: _codeCompletionDatabase(),
    logLevel: _logLevel(),
    recordsPerPage: _recordsPerPage(),
    useNativeDriver: _useNativeDriver(),
    isqlPath: _isqlPath(),
    gbakPath: _gbakPath(),
    showSystemObjects: _showSystemObjects(),
    dockerPath: _dockerPath(),
    enableConnectionPooling: _enableConnectionPooling(),
    connectionPoolMaxSize: _connectionPoolMaxSize(),
    connectionPoolIdleTimeoutMs: _connectionPoolIdleTimeoutMs(),
    profilerPollIntervalMs: _profilerPollIntervalMs(),
    shortcuts: _shortcuts(),
    transactionIsolationLevel: _transactionIsolationLevel(),
    transactionLockTimeoutSec: _transactionLockTimeoutSec(),
    transactionReadOnly: _transactionReadOnly(),
    transactionWaitMode: _transactionWaitMode(),
    mcpEnabled: _mcpEnabled(),
    resultsFontSize: _resultsFontSize(),
    resultsFontFamily: _resultsFontFamily(),
    quickQueries: _quickQueries()
  } as Options;
}

/**
 * Result-view webview shortcuts, mirroring vscode-mssql's `mssql.shortcuts`: these are handled
 * entirely inside the webview's own keydown listener (a VS Code `contributes.keybindings` entry
 * can't reach into webview content), so combos use vscode-mssql's own syntax rather than VS Code's
 * keybindings.json syntax — "ctrlcmd" for Ctrl on Windows/Linux and Cmd on macOS, "+"-joined
 * modifiers, e.g. "ctrlcmd+alt+i". Setting a value to "" disables that shortcut.
 */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "event.toggleEditing": "ctrlcmd+alt+g",
  "event.addRow": "ctrlcmd+alt+n",
  "event.applyChanges": "ctrlcmd+alt+s",
  "event.toggleFreezeColumn": "ctrlcmd+alt+z",
  "event.copyAsInsert": "ctrlcmd+alt+i",
  "event.copyAsInClause": "ctrlcmd+alt+k",
};

function getConfig(): WorkspaceConfiguration {
  return workspace.getConfiguration("firebird");
}

function _mockarooApiKey(): string | null {
  const apiKeyConf: any = getConfig().get("mockarooApiKey");
  // const apiKey: string = properties["firebird.mockarooApiKey"]["default"];

  if (apiKeyConf === "") {
    return null;
  } else {
    return apiKeyConf;
  }
}

function _maxResultRows(): number {
  const configured: any = getConfig().get("maxResultRows");
  const fallback: number = properties["firebird.maxResultRows"]["default"];

  // Negative is meaningless here and 0 already means "no limit", so anything below zero is a
  // mistake rather than an intent worth honouring.
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 0) {
    logger.error("Invalid settings detected in Max Result Rows. Fallback to default value.");
    return fallback;
  }
  return configured;
}

function _maxTablesCount(): number {
  const maxTablesCountConf: any = getConfig().get("maxTablesCount");
  const maxTablesCount: number = properties["firebird.maxTablesCount"]["default"];

  if (typeof maxTablesCountConf !== "number") {
    logger.error("Invalid settings detected in Max Tables Count. Fallback to default value.");
    return maxTablesCount;
  } else {
    return maxTablesCountConf;
  }
}

function _codeCompletionKeywords(): boolean {
  const codeCompletionKeywordsConf: any = getConfig().get("codeCompletion.keywords");
  const codeCompletionKeywords: boolean = properties["firebird.codeCompletion.keywords"]["default"];

  if (typeof codeCompletionKeywordsConf !== "boolean") {
    logger.error("Invalid value detected in Code Completion Keywords settings. Fallback to default value.");
    return codeCompletionKeywords;
  } else {
    return codeCompletionKeywordsConf;
  }
}

function _codeCompletionDatabase(): boolean {
  const codeCompletionDatabaseConf: any = getConfig().get("codeCompletion.database");
  const codeCompletionDatabase: boolean = properties["firebird.codeCompletion.database"]["default"];

  if (typeof codeCompletionDatabaseConf !== "boolean") {
    logger.error("Invalid value detected in Code Completion Database settings. Fallback to default value.");
    return codeCompletionDatabase;
  } else {
    return codeCompletionDatabaseConf;
  }
}

function _useNativeDriver(): boolean {
  const useNativeDriverConf: any = getConfig().get("useNativeDriver");
  const useNativeDriver: boolean = properties["firebird.useNativeDriver"]["default"];

  if (typeof useNativeDriverConf !== "boolean") {
    logger.error("Invalid value detected in Use Native Client settings. Fallback to default value.");
    return useNativeDriver;
  } else {
    return useNativeDriverConf;
  }
}
function _logLevel(): string {
  const logLevelConf: any = getConfig().get("logLevel");
  const logLevel: string = properties["firebird.logLevel"]["default"];

  if (logLevelConf && (<any>Level)[`${logLevelConf}`] !== null) {
    return logLevelConf.toString();
  } else {
    logger.error("Invalid value detected in Log Level settings. Fallback to default value.");
    return logLevel;
  }
}

function _isqlPath(): string {
  const isqlPathConf: any = getConfig().get("isqlPath");
  return typeof isqlPathConf === "string" ? isqlPathConf : "";
}

function _gbakPath(): string {
  const gbakPathConf: any = getConfig().get("gbakPath");
  return typeof gbakPathConf === "string" ? gbakPathConf : "";
}

function _dockerPath(): string {
  const dockerPathConf: any = getConfig().get("dockerPath");
  return typeof dockerPathConf === "string" ? dockerPathConf : "";
}

function _showSystemObjects(): boolean {
  const showSystemObjectsConf: any = getConfig().get("showSystemObjects");
  const showSystemObjects: boolean = properties["firebird.showSystemObjects"]["default"];

  if (typeof showSystemObjectsConf !== "boolean") {
    return showSystemObjects;
  }
  return showSystemObjectsConf;
}

function _enableConnectionPooling(): boolean {
  const conf: any = getConfig().get("enableConnectionPooling");
  const enableConnectionPooling: boolean = properties["firebird.enableConnectionPooling"]["default"];

  if (typeof conf !== "boolean") {
    logger.error("Invalid value detected in Enable Connection Pooling settings. Fallback to default value.");
    return enableConnectionPooling;
  }
  return conf;
}

function _connectionPoolMaxSize(): number {
  const conf: any = getConfig().get("connectionPool.maxSize");
  const connectionPoolMaxSize: number = properties["firebird.connectionPool.maxSize"]["default"];

  if (typeof conf !== "number" || conf < 1) {
    logger.error("Invalid value detected in Connection Pool Max Size settings. Fallback to default value.");
    return connectionPoolMaxSize;
  }
  return conf;
}

function _connectionPoolIdleTimeoutMs(): number {
  const conf: any = getConfig().get("connectionPool.idleTimeoutMs");
  const connectionPoolIdleTimeoutMs: number = properties["firebird.connectionPool.idleTimeoutMs"]["default"];

  if (typeof conf !== "number" || conf < 1) {
    logger.error("Invalid value detected in Connection Pool Idle Timeout settings. Fallback to default value.");
    return connectionPoolIdleTimeoutMs;
  }
  return conf;
}

function _profilerPollIntervalMs(): number {
  const conf: any = getConfig().get("profiler.pollIntervalMs");
  const profilerPollIntervalMs: number = properties["firebird.profiler.pollIntervalMs"]["default"];

  if (typeof conf !== "number" || conf < 500) {
    logger.error("Invalid value detected in Profiler Poll Interval settings. Fallback to default value.");
    return profilerPollIntervalMs;
  }
  return conf;
}

function _shortcuts(): Record<string, string> {
  const conf: any = getConfig().get("shortcuts");
  const merged: Record<string, string> = { ...DEFAULT_SHORTCUTS };
  if (conf && typeof conf === "object") {
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof conf[key] === "string") {
        merged[key] = conf[key];
      }
    }
  }
  return merged;
}

const VALID_ISOLATION_LEVELS = ["", "READ_COMMITTED_RECORD_VERSION", "READ_COMMITTED_NO_RECORD_VERSION", "SNAPSHOT", "SNAPSHOT_TABLE_STABILITY"];

function _transactionIsolationLevel(): Options["transactionIsolationLevel"] {
  const conf: any = getConfig().get("transaction.isolationLevel");
  if (typeof conf === "string" && VALID_ISOLATION_LEVELS.includes(conf)) {
    return conf as Options["transactionIsolationLevel"];
  }
  logger.error("Invalid value detected in Transaction Isolation Level settings. Fallback to default value.");
  return "";
}

function _transactionLockTimeoutSec(): number {
  const conf: any = getConfig().get("transaction.lockTimeoutSec");
  const def: number = properties["firebird.transaction.lockTimeoutSec"]["default"];

  if (typeof conf !== "number" || conf < 0) {
    logger.error("Invalid value detected in Transaction Lock Timeout settings. Fallback to default value.");
    return def;
  }
  return conf;
}

function _transactionReadOnly(): boolean {
  const conf: any = getConfig().get("transaction.readOnly");
  const def: boolean = properties["firebird.transaction.readOnly"]["default"];

  if (typeof conf !== "boolean") {
    return def;
  }
  return conf;
}

const VALID_WAIT_MODES = ["", "WAIT", "NO_WAIT"];

function _transactionWaitMode(): Options["transactionWaitMode"] {
  const conf: any = getConfig().get("transaction.waitMode");
  if (typeof conf === "string" && VALID_WAIT_MODES.includes(conf)) {
    return conf as Options["transactionWaitMode"];
  }
  logger.error("Invalid value detected in Transaction Wait Mode settings. Fallback to default value.");
  return "";
}

function _mcpEnabled(): boolean {
  const conf: any = getConfig().get("mcp.enabled");
  const def: boolean = properties["firebird.mcp.enabled"]["default"];
  if (typeof conf !== "boolean") {
    return def;
  }
  return conf;
}

function _resultsFontSize(): number {
  const conf: any = getConfig().get("resultsFontSize");
  const def: number = properties["firebird.resultsFontSize"]["default"];

  if (typeof conf !== "number" || conf < 0) {
    logger.error("Invalid value detected in Results Font Size settings. Fallback to default value.");
    return def;
  }
  return conf;
}

function _resultsFontFamily(): string {
  const conf: any = getConfig().get("resultsFontFamily");
  return typeof conf === "string" ? conf : "";
}

/**
 * Quick Queries (docs/roadmap/quick-queries.md) — validation lives in `parseQuickQueries()` rather
 * than here, since this setting's value is free-form user JSON with per-entry rules, not a single
 * scalar to range-check like every other accessor in this file.
 */
function _quickQueries(): QuickQuerySlot[] {
  return parseQuickQueries(getConfig().get("quickQueries"));
}

function _recordsPerPage(): string {
  const valid: string[] = ["10", "25", "50", "100", "All records"];
  const recordsPerPageConf: any = getConfig().get("recordsPerPage");
  const recordsPerPage: any = properties["firebird.recordsPerPage"]["default"];

  if (typeof recordsPerPageConf === "string" && valid.indexOf(recordsPerPageConf) > -1) {
    return recordsPerPageConf;
  }
  logger.error("Invalid value detected in Records Per Page settings. Fallback to default value.");
  return recordsPerPage;
}

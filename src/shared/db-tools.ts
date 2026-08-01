/**
 * Transport-agnostic Firebird tool implementations (docs/roadmap/language-model-tools.md, phase 1)
 * — `list_connections`, `get_schema`, `run_query`, `get_query_plan`, `run_write_query`.
 *
 * These five started life inline in `src/mcp-server/server.ts`. They're extracted here because the
 * same five operations now have two callers with nothing else in common: the standalone MCP
 * subprocess (plain Node, speaks stdio, connects with raw `node-firebird`) and the extension host's
 * Language Model Tools (`vscode.lm.registerTool`, connects through `Driver`). Everything that
 * differs between them — how you get a connection, how you run a statement, where an audit entry
 * goes — is behind `ToolExecutor`; everything that must *not* differ — which statements are
 * refused, what the write gate checks, how a result is shaped, what the model is told — lives here.
 *
 * Deliberately free of any `vscode` import, and it has to stay that way: the MCP subprocess is a
 * plain Node process where `require('vscode')` doesn't resolve at all (see that file's own header).
 * Only modules already proven safe for it are imported below — `queries.ts`, `schema-graph.ts`,
 * `sql-analysis.ts`, all of which the subprocess already used directly.
 *
 * The payoff beyond deduplication: with `ToolExecutor` as a seam, this logic is unit-testable
 * against a fake executor with no database and no MCP client, which none of it was before.
 */

import { getSchemaColumnsQuery, getForeignKeysQuery } from "./queries";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow } from "../schema-designer/schema-graph";
import { getEngineMajorVersion } from "./engine-version";
import { supportsSchemas } from "./schema-support";
import {
  validateReadOnlyStatement,
  validateWriteStatement,
  extractTableNames,
  buildIndexMetadataQuery,
  renderIndexMetadataPlan,
} from "./sql-analysis";

/** What a tool caller is allowed to learn about a connection — never a password. */
export interface ToolConnectionInfo {
  id: string;
  label: string;
  host: string;
  database: string;
  /** Whether `run_write_query` is permitted here, so a caller can tell without having to try it first. */
  writeEnabled: boolean;
}

/** Runs one statement on an already-open connection. Resolves `undefined` for a statement with no result set. */
export type ToolQueryFn = (sql: string, params?: any[]) => Promise<any[] | undefined>;

/** One `run_write_query` attempt, successful or not. */
export interface WriteAuditEntry {
  connectionId: string;
  sql: string;
  success: boolean;
  error?: string;
}

/**
 * The transport's own database access. `withConnection()` owns connect/detach so a tool that needs
 * two statements (`get_schema`) runs both on one connection rather than reconnecting per statement.
 */
export interface ToolExecutor {
  listConnections(): Promise<ToolConnectionInfo[]>;
  withConnection<T>(connectionId: string, run: (query: ToolQueryFn) => Promise<T>): Promise<T>;
  /**
   * Records a write attempt. Optional because not every transport has somewhere to put it, and
   * because an audit failure must never turn a successful write into a reported failure — callers
   * implementing this should swallow their own errors.
   */
  audit?(entry: WriteAuditEntry): void;
}

/** A tool's result, in the one shape both transports can render. */
export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

function ok(text: string): ToolOutcome {
  return { text };
}

function fail(text: string): ToolOutcome {
  return { text, isError: true };
}

function asMessage(err: any): string {
  return err?.message ?? String(err);
}

/**
 * Tool descriptions, shared so the MCP server and the LM-tool contribution can't drift into
 * describing the same tool differently to two different models. Written as instructions *to a
 * model*, which is why they state the restrictions rather than just the capability — a model that
 * knows `run_query` refuses writes asks for `run_write_query` instead of retrying a rejected
 * statement.
 */
export const TOOL_DESCRIPTIONS = {
  list_connections:
    "Lists the Firebird connections available to this VS Code workspace. Never includes credentials. writeEnabled tells you upfront whether run_write_query is allowed for a given connection, without needing to try it first.",
  get_schema:
    "Returns the schema (tables, columns, primary keys, and foreign keys) of one Firebird connection.",
  run_query:
    "Executes a single read-only SELECT (or WITH ... AS (...) SELECT) statement against a Firebird connection and returns the resulting rows as JSON. Any other statement (INSERT/UPDATE/DELETE/DDL/EXECUTE BLOCK) or more than one statement is rejected — this tool is read-only.",
  get_query_plan:
    "Returns Firebird's index-metadata-based execution plan heuristic for a single SELECT statement. Read-only, same restriction as run_query.",
  run_write_query:
    "Executes a single INSERT, UPDATE, or DELETE statement against a Firebird connection that has ALSO been explicitly write-enabled (see list_connections' writeEnabled field) — a separate, narrower opt-in on top of being available at all, granted from the connection's right-click menu in VS Code ('Toggle MCP Server Write Access'). Any other statement (SELECT/DDL/EXECUTE BLOCK) or more than one statement is rejected — use run_query for SELECT. Every attempt, successful or not, is recorded in this workspace's write-audit log. Only ever call this after the user has explicitly asked for a specific write, never speculatively.",
} as const;

/**
 * Resolves a connection id, or explains what to do instead. Shared so all four id-taking tools
 * refuse an unknown id identically — a model that gets the same sentence every time learns to call
 * `list_connections` first, which is exactly what the sentence tells it to do.
 */
async function resolveConnection(
  executor: ToolExecutor,
  connectionId: string
): Promise<{ connection: ToolConnectionInfo } | { outcome: ToolOutcome }> {
  const connection = (await executor.listConnections()).find(c => c.id === connectionId);
  if (!connection) {
    return {
      outcome: fail(`No Firebird connection with id "${connectionId}" is available. Call list_connections first.`),
    };
  }
  return { connection };
}

export async function listConnectionsTool(executor: ToolExecutor): Promise<ToolOutcome> {
  const connections = await executor.listConnections();
  return ok(JSON.stringify(connections, null, 2));
}

export async function getSchemaTool(executor: ToolExecutor, connectionId: string): Promise<ToolOutcome> {
  const resolved = await resolveConnection(executor, connectionId);
  if ("outcome" in resolved) {
    return resolved.outcome;
  }

  try {
    const graph = await executor.withConnection(connectionId, async query => {
      // Firebird 6 keeps every object in a schema. Without asking for it the graph merges
      // same-named tables from different schemas into one entry holding the union of their
      // columns — and an agent reading that would write SQL against a table that does not exist,
      // which is a worse failure here than in any UI.
      const withSchemas = supportsSchemas(
        await getEngineMajorVersion(connectionId, async sql => (await query(sql)) ?? [])
      );
      const columnRows = (await query(getSchemaColumnsQuery(withSchemas))) as SchemaColumnRow[] | undefined;
      const fkRows = (await query(getForeignKeysQuery(withSchemas))) as ForeignKeyRow[] | undefined;
      return buildSchemaGraph(columnRows ?? [], fkRows ?? []);
    });
    return ok(JSON.stringify(graph, null, 2));
  } catch (err: any) {
    return fail(`Could not fetch schema: ${asMessage(err)}`);
  }
}

export async function runQueryTool(executor: ToolExecutor, connectionId: string, sql: string): Promise<ToolOutcome> {
  const resolved = await resolveConnection(executor, connectionId);
  if ("outcome" in resolved) {
    return resolved.outcome;
  }

  const rejection = validateReadOnlyStatement(sql);
  if (rejection) {
    return fail(rejection);
  }

  try {
    const rows = await executor.withConnection(connectionId, query => query(sql));
    return ok(JSON.stringify(rows ?? [], null, 2));
  } catch (err: any) {
    return fail(`Query failed: ${asMessage(err)}`);
  }
}

export async function getQueryPlanTool(executor: ToolExecutor, connectionId: string, sql: string): Promise<ToolOutcome> {
  const resolved = await resolveConnection(executor, connectionId);
  if ("outcome" in resolved) {
    return resolved.outcome;
  }

  const rejection = validateReadOnlyStatement(sql);
  if (rejection) {
    return fail(rejection);
  }

  const tables = extractTableNames(sql);
  if (tables.length === 0) {
    // Nothing to look indexes up for — render the "no tables recognized" plan without connecting.
    return ok(renderIndexMetadataPlan(sql, tables, []));
  }

  try {
    const rows = await executor.withConnection(connectionId, query => query(buildIndexMetadataQuery(tables), tables));
    return ok(renderIndexMetadataPlan(sql, tables, rows ?? []));
  } catch (err: any) {
    return fail(`Could not fetch query plan: ${asMessage(err)}`);
  }
}

/**
 * The one tool that mutates. Both refusal paths (connection not write-enabled, statement isn't a
 * single INSERT/UPDATE/DELETE) are audited as well as the attempt itself — a refused write is
 * exactly the kind of thing someone reading the audit log later wants to know was tried.
 *
 * Note the unknown-connection path is deliberately *not* audited: there's no connection to attribute
 * the entry to, and an id that doesn't resolve never reached a database.
 */
export async function runWriteQueryTool(executor: ToolExecutor, connectionId: string, sql: string): Promise<ToolOutcome> {
  const resolved = await resolveConnection(executor, connectionId);
  if ("outcome" in resolved) {
    return resolved.outcome;
  }

  if (!resolved.connection.writeEnabled) {
    const message = `Write access is not enabled for connection "${connectionId}". Enable it from the connection's right-click menu in the Firebird Studio tree in VS Code ("Toggle MCP Server Write Access") first.`;
    executor.audit?.({ connectionId, sql, success: false, error: message });
    return fail(message);
  }

  const rejection = validateWriteStatement(sql);
  if (rejection) {
    executor.audit?.({ connectionId, sql, success: false, error: rejection });
    return fail(rejection);
  }

  try {
    const rows = await executor.withConnection(connectionId, query => query(sql));
    executor.audit?.({ connectionId, sql, success: true });
    // Rows come back only for a RETURNING clause; a plain DML statement resolves undefined.
    return ok(rows !== undefined ? JSON.stringify(rows, null, 2) : "Statement executed successfully.");
  } catch (err: any) {
    const message = asMessage(err);
    executor.audit?.({ connectionId, sql, success: false, error: message });
    return fail(`Write failed: ${message}`);
  }
}

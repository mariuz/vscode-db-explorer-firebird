#!/usr/bin/env node
/**
 * Standalone MCP server subprocess (docs/roadmap/mcp-server.md) — list_connections, get_schema,
 * run_query, get_query_plan (all read-only), and the opt-in run_write_query. VS Code's `vscode.lm.
 * registerMcpServerDefinitionProvider` model spawns this as a *separate* child process speaking
 * MCP over stdio — it is NOT part of the extension host and cannot import `vscode` (no such
 * module exists in a plain Node process), so it can't reuse `Driver`/`NodeClient` (which import
 * vscode) or `CredentialStore` (which needs `ExtensionContext.secrets`). It reuses whatever is
 * genuinely dependency-free instead: getSchemaColumnsQuery()/getForeignKeysQuery()/
 * buildSchemaGraph() from the main extension's own shared modules.
 *
 * Connection details for whichever connections the user explicitly exposed (see
 * ConnectionOptions.mcpExposed, toggled from the tree) are handed to this process via the
 * FIREBIRD_MCP_CONNECTIONS environment variable, resolved and populated by the extension host in
 * src/mcp-server/index.ts's resolveMcpServerDefinition() — the same "credentials via env var to a
 * spawned child process," never argv or disk, pattern src/shared/isql-terminal.ts already uses.
 * FIREBIRD_MCP_AUDIT_LOG_PATH (also set there) is where run_write_query appends one JSON line per
 * write attempt — this subprocess has no VS Code UI to confirm or even display anything with, so
 * the extension host relays that file's new lines into its own output channel instead (see
 * src/mcp-server/index.ts's startAuditLogWatcher()).
 *
 * IMPORTANT: stdout is the MCP JSON-RPC message stream itself — never `console.log` here, only
 * `console.error` (stderr), or a stray line corrupts the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as Firebird from "node-firebird";
import { appendFileSync } from "fs";
import {
  getQueryPlanTool,
  getSchemaTool,
  listConnectionsTool,
  runQueryTool,
  runWriteQueryTool,
  ToolExecutor,
  ToolOutcome,
  ToolQueryFn,
  TOOL_DESCRIPTIONS,
} from "../shared/db-tools";

interface ExposedConnection {
  id: string;
  label: string;
  host: string;
  port: number | null;
  database: string;
  user: string;
  password: string;
  role: string | null;
  embedded: boolean;
  /** docs/roadmap/mcp-server.md's write-query path — a separate, narrower opt-in on top of being exposed at all. Gates run_write_query only; list_connections/get_schema/run_query/get_query_plan are unaffected. */
  writeEnabled: boolean;
}

function loadExposedConnections(): ExposedConnection[] {
  const raw = process.env.FIREBIRD_MCP_CONNECTIONS;
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("firebird-mcp: could not parse FIREBIRD_MCP_CONNECTIONS", err);
    return [];
  }
}

function connect(conn: ExposedConnection): Promise<Firebird.Database> {
  return new Promise((resolve, reject) => {
    if (conn.embedded) {
      // No native driver in this subprocess (deliberately not bundled — see the design doc);
      // embedded connections require it, matching NodeClient.createConnection()'s own guard.
      reject(new Error("Embedded connections aren't supported by the MCP server yet — only network connections."));
      return;
    }
    Firebird.attach(
      { host: conn.host, port: conn.port ?? 3050, database: conn.database, user: conn.user, password: conn.password, role: conn.role ?? undefined },
      (err, db) => {
        if (err) { reject(err); return; }
        resolve(db);
      }
    );
  });
}

function query<T = any>(db: Firebird.Database, sql: string, args: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.query(sql, args, (err: any, rows: any) => {
      if (err) { reject(err); return; }
      resolve(rows);
    });
  });
}

function detach(db: Firebird.Database): Promise<void> {
  return new Promise(resolve => db.detach(() => resolve()));
}

/**
 * Appends one JSON line to the write-audit log for every run_write_query attempt, success or
 * failure — the only record of a write an *external* MCP client made, since this subprocess has no
 * VS Code UI to confirm or surface anything through directly (see the module doc comment above).
 * Never lets a logging failure (disk full, path unset, whatever) break the actual tool response —
 * this is a best-effort audit trail, not something a write's own success should depend on.
 */
function appendAuditLog(entry: { connectionId: string; sql: string; success: boolean; error?: string }): void {
  const path = process.env.FIREBIRD_MCP_AUDIT_LOG_PATH;
  if (!path) {
    return;
  }
  try {
    appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("firebird-mcp: could not write to the write-audit log", err);
  }
}

const server = new McpServer({ name: "firebird-mcp", version: "1.0.0" });

/**
 * This subprocess's half of `ToolExecutor` (src/shared/db-tools.ts) — raw `node-firebird`, one
 * attach per tool call, audit entries appended to the file the extension host handed us via
 * FIREBIRD_MCP_AUDIT_LOG_PATH. The tools' actual behavior (what's refused, what the write gate
 * checks, how results are shaped) lives in db-tools.ts and is shared with the extension host's
 * Language Model Tools; only the plumbing below is specific to being a separate process.
 */
const executor: ToolExecutor = {
  async listConnections() {
    return loadExposedConnections().map(c => ({
      id: c.id,
      label: c.label,
      host: c.host,
      database: c.database,
      writeEnabled: c.writeEnabled,
    }));
  },

  async withConnection<T>(connectionId: string, run: (query: ToolQueryFn) => Promise<T>): Promise<T> {
    const conn = loadExposedConnections().find(c => c.id === connectionId);
    if (!conn) {
      // db-tools.ts resolves the id before calling this, so reaching here means the exposed set
      // changed underneath us mid-call — a real error, not a lookup miss to report as a tool result.
      throw new Error(`Connection "${connectionId}" is no longer exposed.`);
    }
    const db = await connect(conn);
    try {
      return await run((sql, args) => query(db, sql, args ?? []));
    } finally {
      await detach(db);
    }
  },

  audit(entry) {
    appendAuditLog(entry);
  },
};

/** Renders a db-tools outcome as an MCP tool result. */
function toMcpResult(outcome: ToolOutcome) {
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    ...(outcome.isError ? { isError: true } : {}),
  };
}

const connectionIdArg = z.string().describe("A connection id returned by list_connections");

server.registerTool(
  "list_connections",
  { description: TOOL_DESCRIPTIONS.list_connections, inputSchema: {} },
  async () => toMcpResult(await listConnectionsTool(executor))
);

server.registerTool(
  "get_schema",
  { description: TOOL_DESCRIPTIONS.get_schema, inputSchema: { connectionId: connectionIdArg } },
  async ({ connectionId }) => toMcpResult(await getSchemaTool(executor, connectionId))
);

server.registerTool(
  "run_query",
  {
    description: TOOL_DESCRIPTIONS.run_query,
    inputSchema: { connectionId: connectionIdArg, sql: z.string().describe("A single SELECT statement") },
  },
  async ({ connectionId, sql }) => toMcpResult(await runQueryTool(executor, connectionId, sql))
);

server.registerTool(
  "get_query_plan",
  {
    description: TOOL_DESCRIPTIONS.get_query_plan,
    inputSchema: { connectionId: connectionIdArg, sql: z.string().describe("A single SELECT statement") },
  },
  async ({ connectionId, sql }) => toMcpResult(await getQueryPlanTool(executor, connectionId, sql))
);

server.registerTool(
  "run_write_query",
  {
    description: TOOL_DESCRIPTIONS.run_write_query,
    inputSchema: {
      connectionId: z.string().describe("A connection id returned by list_connections, with writeEnabled: true"),
      sql: z.string().describe("A single INSERT, UPDATE, or DELETE statement"),
    },
  },
  async ({ connectionId, sql }) => toMcpResult(await runWriteQueryTool(executor, connectionId, sql))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("firebird-mcp: running on stdio");
}

main().catch(err => {
  console.error("firebird-mcp: fatal error", err);
  process.exit(1);
});

import * as vscode from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { getOptions } from "../config";
import { Driver, buildTransactionOptions } from "../shared/driver";
import { getConnectionLabel } from "../shared/utils";
import { loadWorkspaceConnections } from "../shared/workspace-config";
import { logger } from "../logger/logger";
import {
  getQueryPlanTool,
  getSchemaTool,
  listConnectionsTool,
  runQueryTool,
  runWriteQueryTool,
  ToolExecutor,
  ToolOutcome,
  ToolQueryFn,
} from "../shared/db-tools";

/**
 * Language Model Tools (docs/roadmap/language-model-tools.md, phases 2-3) — the same five
 * operations the MCP server exposes, registered with `vscode.lm.registerTool` so Copilot **agent
 * mode** can call them directly, and `#firebird…`-referenced in ask mode, with no MCP server and no
 * separate client process involved.
 *
 * The tools' behavior isn't here: it's in `src/shared/db-tools.ts`, shared verbatim with the MCP
 * subprocess so the two transports can't drift on what's refused, what the write gate checks, or
 * how a result is shaped. This file is only the VS Code half — the `Driver`-backed `ToolExecutor`,
 * the `LanguageModelTool` wrappers, and the write confirmation.
 *
 * **Connection scope** differs from the MCP server's on purpose. The MCP server is an external
 * process talking to clients outside VS Code, so it only ever sees connections explicitly marked
 * `mcpExposed`. These tools run inside the extension host, on behalf of the user's own Copilot
 * session, in their own workspace — the same trust boundary the `@firebird` chat participant
 * already operates at (it reads the active connection's schema with no separate opt-in). So they
 * see every saved connection, exactly the set `connection-sharing`'s own `listConnections()`
 * returns. **Writes are the exception**: those still require the explicit per-connection
 * `mcpWriteEnabled` opt-in, reusing the existing gate rather than inventing a second one.
 */

/** Registered tool names — must match `contributes.languageModelTools` in package.json. */
const TOOL_NAMES = {
  listConnections: "firebird_listConnections",
  getSchema: "firebird_getSchema",
  runQuery: "firebird_runQuery",
  getQueryPlan: "firebird_getQueryPlan",
  runWriteQuery: "firebird_runWriteQuery",
} as const;

interface ConnectionIdInput {
  connectionId: string;
}

interface SqlInput extends ConnectionIdInput {
  sql: string;
}

/** Every connection this workspace can see — globalState-saved plus `.vscode/firebird.json`. */
async function loadAllConnections(context: vscode.ExtensionContext): Promise<ConnectionOptions[]> {
  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  const workspaceConnections = await loadWorkspaceConnections();

  const all = new Map<string, ConnectionOptions>();
  for (const [id, conn] of Object.entries(saved)) {
    all.set(id, { ...conn, id });
  }
  for (const conn of workspaceConnections) {
    all.set(conn.id, conn);
  }
  return [...all.values()];
}

/**
 * The extension host's half of `ToolExecutor`. Connects through `Driver.client` rather than
 * `Driver.runQuery()` so a statement with no result set resolves `undefined` — the raw driver
 * semantics `db-tools.ts` is written against, and what the MCP subprocess's executor also produces.
 * `Driver.runQuery()` would instead substitute its own `[{message: "..."}]` array for DDL/DML,
 * which would silently change what `run_write_query` reports depending on which transport ran it.
 */
export function createLmToolExecutor(context: vscode.ExtensionContext): ToolExecutor {
  return {
    async listConnections() {
      const connections = await loadAllConnections(context);
      return connections.map(conn => ({
        id: conn.id,
        label: getConnectionLabel(conn),
        host: conn.host,
        database: conn.database,
        writeEnabled: !!conn.mcpWriteEnabled,
      }));
    },

    async withConnection<T>(connectionId: string, run: (query: ToolQueryFn) => Promise<T>): Promise<T> {
      const connections = await loadAllConnections(context);
      const found = connections.find(conn => conn.id === connectionId);
      if (!found) {
        // db-tools.ts resolves the id first, so this only fires if the saved set changed mid-call.
        throw new Error(`Connection "${connectionId}" is no longer available.`);
      }
      // Required when bypassing runQuery()/runBatch(): saved connections never carry a password.
      const resolved = await Driver.resolvePassword(found);
      const txOptions = buildTransactionOptions(getOptions());
      const connection = await Driver.client.createConnection(resolved);
      try {
        return await run((sql, params) => Driver.client.queryPromise(connection, sql, params, txOptions));
      } finally {
        Driver.client.detach(connection);
      }
    },

    audit(entry) {
      // The MCP subprocess has no UI, so it appends to a log file the host tails back into the
      // output channel. Here we're already *in* the host — log straight to the same channel.
      logger.info(
        `[language model tool] write ${entry.success ? "succeeded" : "refused/failed"} on connection ${entry.connectionId}: ${entry.sql}` +
        (entry.error ? ` — ${entry.error}` : "")
      );
    },
  };
}

function toToolResult(outcome: ToolOutcome): vscode.LanguageModelToolResult {
  // A refusal is returned as text, not thrown: the model should read why it was refused and adjust
  // (ask for run_write_query, fix the statement), which a thrown error doesn't reliably convey.
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(outcome.text)]);
}

/**
 * Registers all five tools. Guarded on `vscode.lm.registerTool` actually existing, the same way
 * the chat participant guards on `vscode.chat` — this extension declares a lower `engines.vscode`
 * floor than some of the APIs it can opportunistically use, and the vscode-host activation test
 * must not depend on which of them the running VS Code happens to have.
 */
export function registerLanguageModelTools(context: vscode.ExtensionContext): vscode.Disposable[] {
  if (typeof vscode.lm === "undefined" || typeof vscode.lm.registerTool !== "function") {
    logger.debug("vscode.lm.registerTool is unavailable — skipping language model tool registration.");
    return [];
  }

  const executor = createLmToolExecutor(context);

  const register = <T>(name: string, invoke: (input: T) => Promise<ToolOutcome>): vscode.Disposable =>
    vscode.lm.registerTool<T>(name, {
      invoke: async options => toToolResult(await invoke(options.input)),
    });

  return [
    register<Record<string, never>>(TOOL_NAMES.listConnections, () => listConnectionsTool(executor)),
    register<ConnectionIdInput>(TOOL_NAMES.getSchema, input => getSchemaTool(executor, input.connectionId)),
    register<SqlInput>(TOOL_NAMES.runQuery, input => runQueryTool(executor, input.connectionId, input.sql)),
    register<SqlInput>(TOOL_NAMES.getQueryPlan, input => getQueryPlanTool(executor, input.connectionId, input.sql)),

    // The write tool is the one that needs a confirmation: agent mode invokes tools unattended, and
    // prepareInvocation()'s confirmationMessages is the API's own affordance for "this mutates
    // something, ask first". The mcpWriteEnabled gate inside runWriteQueryTool still applies on top
    // — a connection without it refuses the write even if the user confirms here.
    vscode.lm.registerTool<SqlInput>(TOOL_NAMES.runWriteQuery, {
      prepareInvocation: async options => ({
        invocationMessage: "Running a Firebird write statement",
        confirmationMessages: {
          title: "Run a write statement against Firebird?",
          message: new vscode.MarkdownString(
            `This will modify data on connection \`${options.input.connectionId}\`:\n\n\`\`\`sql\n${options.input.sql}\n\`\`\``
          ),
        },
      }),
      invoke: async options => toToolResult(await runWriteQueryTool(executor, options.input.connectionId, options.input.sql)),
    }),
  ];
}

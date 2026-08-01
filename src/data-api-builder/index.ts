import * as vscode from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getSchemaColumnsQuery, getForeignKeysQuery } from "../shared/queries";
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas } from "../shared/schema-support";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow, SchemaGraph } from "../schema-designer/schema-graph";
import { buildOpenApiSpec, TableAccess, TableAccessLevel } from "./openapi-spec";
import { extractJson } from "../copilot/json-extraction";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "../shared/utils";

/**
 * Generates an OpenAPI 3.0 spec (one CRUD route set per table) from the connected schema and
 * opens it as a plain JSON document for review — Option A from the design doc, deliberately not
 * a bundled server the extension runs itself.
 */
export async function runDataApiSpecGenerator(connectionOptions: ConnectionOptions): Promise<void> {
  const graph = await fetchSchemaGraph(connectionOptions);
  if (!graph) {
    return;
  }

  const spec = buildOpenApiSpec(graph, { title: `${getDatabaseFileName(connectionOptions.database)} Data API` });
  await openSpecDocument(spec);
  logger.showInfo(`Generated a Data API spec for ${graph.tables.length} table(s). Review it, then hand it to your own REST/GraphQL backend — this extension doesn't run a server itself.`);
}

/**
 * Copilot-assisted scoping (docs/roadmap/data-api-builder.md phase 3): asks the user for a
 * plain-English description of what to expose ("expose customers and orders as read-only"), sends
 * it plus the table list to the language model, and asks for a small structured JSON decision
 * (which tables, and "full" vs "read-only" access for each) — not a raw OpenAPI spec. The model
 * never has to get OpenAPI JSON syntax right; buildOpenApiSpec() (already proven by the plain
 * generator above) turns that decision into the actual spec, the same "small structured edit,
 * deterministic code applies it" split the Schema Designer's "Ask Copilot" panel already uses.
 */
export async function runDataApiSpecGeneratorWithCopilot(connectionOptions: ConnectionOptions): Promise<void> {
  const graph = await fetchSchemaGraph(connectionOptions);
  if (!graph) {
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Generate Data API Spec with Copilot",
    prompt: "Describe which tables to expose and how (e.g. \"expose customers and orders as read-only\")",
    placeHolder: "expose customers and orders as read-only",
  });
  if (!instruction?.trim()) {
    return;
  }

  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const model = models[0];
  if (!model) {
    logger.showError("No Copilot language model is available. Make sure GitHub Copilot Chat is installed and signed in.");
    return;
  }

  const scopingTables: ScopingTable[] = graph.tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name) }));
  const cts = new vscode.CancellationTokenSource();
  let tableAccess: Record<string, TableAccess>;
  try {
    tableAccess = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Asking Copilot which tables to expose…", cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => cts.cancel());
        const messages = [vscode.LanguageModelChatMessage.User(copilotScopingPrompt(scopingTables, instruction))];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = "";
        for await (const fragment of response.text) {
          text += fragment;
        }
        return parseTableAccessResponse(text, scopingTables);
      }
    );
  } catch (err: any) {
    if (err instanceof vscode.CancellationError) {
      return;
    }
    const message = err?.message ?? String(err);
    logger.error(`Data API spec Copilot scoping failed: ${message}`);
    logger.showError(`Copilot could not scope the spec: ${message}`);
    return;
  }

  if (Object.keys(tableAccess).length === 0) {
    logger.showError("Copilot didn't match any of your database's tables to that description — try rephrasing, or use \"Generate Data API Spec...\" for every table.");
    return;
  }

  const spec = buildOpenApiSpec(graph, { title: `${getDatabaseFileName(connectionOptions.database)} Data API`, tableAccess });
  await openSpecDocument(spec);

  const readOnlyCount = Object.values(tableAccess).filter(a => a === "read-only").length;
  const scopeNote = readOnlyCount > 0 ? ` (${readOnlyCount} read-only)` : "";
  logger.showInfo(`Generated a Data API spec for ${Object.keys(tableAccess).length} of ${graph.tables.length} table(s)${scopeNote}, based on your description.`);
}

/** Shared by both generators: fetches the schema over one connection and reports any error itself, so callers only need to check for undefined. */
async function fetchSchemaGraph(connectionOptions: ConnectionOptions): Promise<SchemaGraph | undefined> {
  // Firebird 6 keeps every object in a schema. Without asking for it, same-named tables from
  // different schemas merge into one graph entry — and this generator would then publish REST
  // endpoints for a table that does not exist. Gated on the server version: RDB$SCHEMA_NAME is a
  // hard SQL error before Firebird 6.
  const withSchemas = supportsSchemas(
    await getEngineMajorVersion(connectionOptions.id, async probe => {
      const [row] = await Driver.runBatch(probe, connectionOptions);
      return (row?.rows ?? []) as any[];
    })
  );
  const sql = `${getSchemaColumnsQuery(withSchemas)}\n${getForeignKeysQuery(withSchemas)}`;

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Data API spec generation failed: ${err?.message ?? err}`);
    logger.showError(`Could not read the schema: ${err?.message ?? err}`);
    return undefined;
  }

  const [columnsResult, fkResult] = results;
  if (columnsResult?.error) {
    logger.showError(`Could not read the schema: ${columnsResult.error}`);
    return undefined;
  }
  if (fkResult?.error) {
    logger.showError(`Could not read foreign keys: ${fkResult.error}`);
    return undefined;
  }

  const graph = buildSchemaGraph(
    (columnsResult?.rows ?? []) as SchemaColumnRow[],
    (fkResult?.rows ?? []) as ForeignKeyRow[]
  );
  if (graph.tables.length === 0) {
    logger.showError("No tables found in this database — nothing to generate a Data API spec for.");
    return undefined;
  }
  return graph;
}

async function openSpecDocument(spec: Record<string, any>): Promise<void> {
  const content = JSON.stringify(spec, null, 2);
  const doc = await vscode.workspace.openTextDocument({ content, language: "json" });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

/** Exported for testing. */
export function copilotScopingPrompt(tables: ScopingTable[], instruction: string): string {
  return [
    "You are helping scope a Data API specification (OpenAPI 3.0) generated for a Firebird database.",
    "The user will describe, in plain English, which tables to expose, with what access level, and",
    "optionally which columns to leave out.",
    "",
    "Available tables and their columns:",
    ...tables.map(table => `- ${table.name}: ${table.columns.join(", ")}`),
    "",
    `User's request: ${instruction}`,
    "",
    "Decide which of the available tables above should be exposed, and for each, whether it should have",
    "\"full\" access (list/create/get/update/delete) or \"read-only\" access (list/get only).",
    "Only ever use table and column names from the list above, exactly as spelled there.",
    "Respond with ONLY a JSON object, no other text, no markdown fence. Each table maps either to an",
    "access level string, or to an object when columns should be restricted:",
    '{"tables":{"CUSTOMERS":"full","USERS":{"access":"read-only","excludeColumns":["PASSWORD_HASH"]}}}',
    "Use excludeColumns for a few columns to hide (secrets, password hashes, internal audit columns),",
    "or includeColumns to list the only columns to expose. Omit both to expose every column.",
    "Omit any table that should not be exposed at all — do not include every table by default.",
  ].join("\n");
}

/**
 * Exported for testing. Validates the model's response against the real table list — a
 * hallucinated or misspelled table name is dropped rather than trusted, matching this codebase's
 * existing rule for Copilot-produced structured edits (see schema-designer's applyCopilotEdit()):
 * the model's own claims aren't taken at face value against ground truth the extension already has.
 */
export function parseTableAccessResponse(rawText: string, tables: ScopingTable[]): Record<string, TableAccess> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    throw new Error(`Copilot didn't return valid JSON. Raw response:\n${rawText.slice(0, 500)}`);
  }

  const responseTables = (parsed as { tables?: unknown })?.tables;
  if (typeof responseTables !== "object" || responseTables === null) {
    throw new Error(`Copilot's response didn't have the expected {"tables": {...}} shape. Raw response:\n${rawText.slice(0, 500)}`);
  }

  const knownByUppercase = new Map(tables.map(table => [table.name.toUpperCase(), table]));
  const result: Record<string, TableAccess> = {};
  for (const [name, access] of Object.entries(responseTables as Record<string, unknown>)) {
    const realTable = knownByUppercase.get(name.toUpperCase());
    if (!realTable) {
      continue; // hallucinated/misspelled table name — drop it rather than generate a broken $ref
    }
    result[realTable.name] = parseAccessValue(access, realTable);
  }
  return result;
}

/** A table's real name and column names, the ground truth a Copilot response is validated against. */
export interface ScopingTable {
  name: string;
  columns: string[];
}

/**
 * One table's entry from the model's response. Accepts both the bare access-level string and phase
 * 5's object form. Column names are validated against the table's real ones exactly as table names
 * are — an unknown column is dropped rather than emitted into a spec that references a column the
 * database doesn't have.
 */
function parseAccessValue(value: unknown, table: ScopingTable): TableAccess {
  if (typeof value === "string" || value === null || typeof value !== "object") {
    return value === "read-only" ? "read-only" : "full";
  }

  const entry = value as { access?: unknown; includeColumns?: unknown; excludeColumns?: unknown };
  const access: TableAccessLevel = entry.access === "read-only" ? "read-only" : "full";
  const realByUppercase = new Map(table.columns.map(column => [column.toUpperCase(), column]));
  const validate = (names: unknown): string[] | undefined => {
    if (!Array.isArray(names)) { return undefined; }
    const real = names
      .filter((name): name is string => typeof name === "string")
      .map(name => realByUppercase.get(name.toUpperCase()))
      .filter((name): name is string => name !== undefined);
    return real.length > 0 ? real : undefined;
  };

  const includeColumns = validate(entry.includeColumns);
  const excludeColumns = validate(entry.excludeColumns);
  if (!includeColumns && !excludeColumns) {
    return access; // nothing column-scoped survived validation — the bare level is the whole answer
  }
  return { access, includeColumns, excludeColumns };
}

import { window, workspace, ViewColumn, Uri, commands, ExtensionContext } from "vscode";
import { mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { join, dirname, relative, sep } from "path";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import {
  getSchemaColumnsQuery, getForeignKeysQuery, getAllViewSourcesQuery,
  getAllProcedureSourcesQuery, getAllProcedureParametersQuery, getAllTriggerSourcesQuery, getGeneratorsQuery,
  getAllPrimaryKeyConstraintNamesQuery, getDomainsQuery, getRolesQuery, getExceptionsQuery, getUsersQuery,
} from "../shared/queries";
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas, schemaDisplayName, splitQualifiedName } from "../shared/schema-support";
import { buildSchemaGraph, SchemaColumnRow, ForeignKeyRow, normalizeDefault } from "../schema-designer/schema-graph";
import { buildProjectFiles, MANIFEST_FILE_NAME, ProjectInput, ProcedureParameter } from "./project-model";
import {
  parseObjectPath, buildObjectPath, requalifyDdl, applyMoveToManifestFiles, findReferencingFiles
} from "./move-to-schema";
import { diffProjects, buildPublishScript } from "./publish-model";
import { logger } from "../logger/logger";
import { CredentialStore } from "../shared/credential-store";
import { Constants } from "../config/constants";
import { getConnectionLabel } from "../shared/utils";

export const SNAPSHOT_FILE_NAME = "firebird.project-snapshot.json";

/**
 * Fetches a live connection's schema (tables/columns/FKs/domains/views/procedures/triggers/
 * exceptions/generators/roles/users/PK constraint names) into the same structured ProjectInput
 * shape used to write a project's .sql files — shared by Extract (writes it to disk) and Publish
 * (diffs it against a saved snapshot, with no need for the SchemaDesigner/tree code paths that
 * also read this data).
 */
/** `PUBLIC.X` -> `X`; any other schema keeps its prefix. Mirrors schemaDisplayName() for a name that is already qualified. */
function schemaDisplayNameOf(qualified: string): string {
  const { schema, name } = splitQualifiedName(qualified);
  return schemaDisplayName(schema, name);
}

export async function fetchProjectSnapshot(connectionOptions: ConnectionOptions): Promise<ProjectInput> {
  // Firebird 6 keeps every object in a schema. Without asking for it, same-named tables from
  // different schemas merge into one graph entry with the union of their columns, and Extract
  // would write that fiction to disk as a table's definition. Gated on the server version.
  const withSchemas = supportsSchemas(
    await getEngineMajorVersion(connectionOptions.id, async probe => {
      const [row] = await Driver.runBatch(probe, connectionOptions);
      return (row?.rows ?? []) as any[];
    })
  );

  /**
   * A project identifies every object by its *display* name — bare in the default schema,
   * qualified elsewhere — and uses that one form for file names, for diffing against a target,
   * and in generated DDL.
   *
   * One convention throughout is the point. Mixing them (qualified identity, display file names)
   * made publish emit `CREATE OR ALTER PROCEDURE PUBLIC.PUB_PROC` while comparing against a
   * snapshot that said `PUB_PROC`, so a single-schema Firebird 6 database looked entirely
   * rewritten. A display name is still qualified for any schema other than the default, so
   * nothing becomes ambiguous.
   */
  const display = (schema: unknown, name: unknown) =>
    schemaDisplayName(withSchemas ? String(schema ?? "") : undefined, String(name ?? ""));

  const sql = [
    getSchemaColumnsQuery(withSchemas),
    getForeignKeysQuery(withSchemas),
    getAllViewSourcesQuery(withSchemas),
    getAllProcedureSourcesQuery(withSchemas),
    getAllProcedureParametersQuery(withSchemas),
    getAllTriggerSourcesQuery(withSchemas),
    getGeneratorsQuery(withSchemas),
    getAllPrimaryKeyConstraintNamesQuery(),
    getDomainsQuery(withSchemas),
    getRolesQuery(),
    getExceptionsQuery(withSchemas),
    getUsersQuery(),
  ].join("\n");

  const results = await Driver.runBatch(sql, connectionOptions);
  const [
    columnsResult, fkResult, viewsResult, proceduresResult, procParamsResult, triggersResult, generatorsResult, pkNamesResult,
    domainsResult, rolesResult, exceptionsResult, usersResult,
  ] = results;
  for (const r of [
    columnsResult, fkResult, viewsResult, proceduresResult, procParamsResult, triggersResult, generatorsResult, pkNamesResult,
    domainsResult, rolesResult, exceptionsResult, usersResult,
  ]) {
    if (r?.error) {
      throw new Error(r.error);
    }
  }

  const parametersByProcedure = new Map<string, ProcedureParameter[]>();
  for (const row of (procParamsResult?.rows ?? []) as any[]) {
    const procName = display(row.SCHEMA_NAME, row.PROCEDURE_NAME);
    const list = parametersByProcedure.get(procName) ?? [];
    list.push({
      name: row.PARAM_NAME.trim(),
      direction: row.PARAM_TYPE === 1 ? "out" : "in",
      type: row.FIELD_TYPE.trim(),
      length: row.FIELD_LENGTH ?? 0,
      subType: row.FIELD_SUB_TYPE ?? undefined,
      precision: row.FIELD_PRECISION ?? undefined,
      scale: row.FIELD_SCALE ?? undefined,
    });
    parametersByProcedure.set(procName, list);
  }

  const rawGraph = buildSchemaGraph(
    (columnsResult?.rows ?? []) as SchemaColumnRow[],
    (fkResult?.rows ?? []) as ForeignKeyRow[]
  );

  /**
   * A project identifies objects by their *display* name — bare in the default schema, qualified
   * elsewhere — the same convention its file names and `fetchSchemaSnapshot()` use.
   *
   * `buildSchemaGraph()` qualifies unconditionally, because the Schema Designer's DDL must never
   * depend on the search path. Carrying that into a project instead made every object in a
   * single-schema Firebird 6 database look renamed to publish, which the suite-tier tests caught
   * as `PUB_PARENT should exist in the target snapshot` — publish compared `PUBLIC.PUB_PARENT`
   * against a snapshot saying `PUB_PARENT` and concluded nothing matched.
   *
   * Generated DDL stays unambiguous where it matters: a display name is still qualified for any
   * schema other than the default.
   */
  const graph = {
    ...rawGraph,
    tables: rawGraph.tables.map(t => ({ ...t, name: t.displayName ?? t.name })),
    relationships: rawGraph.relationships.map(r => ({
      ...r,
      table: schemaDisplayNameOf(r.table),
      refTable: schemaDisplayNameOf(r.refTable),
    })),
  };

  const pkConstraintNames: Record<string, string> = {};
  for (const row of (pkNamesResult?.rows ?? []) as any[]) {
    pkConstraintNames[row.TABLE_NAME.trim()] = row.CONSTRAINT_NAME.trim();
  }

  return {
    graph,
    domains: ((domainsResult?.rows ?? []) as any[]).map(r => ({
      name: display(r.SCHEMA_NAME, r.DOMAIN_NAME),
      type: r.DOMAIN_TYPE.trim(),
      length: r.FIELD_LENGTH ?? 0,
      subType: r.FIELD_SUB_TYPE ?? undefined,
      precision: r.FIELD_PRECISION ?? undefined,
      scale: r.FIELD_SCALE ?? undefined,
      notNull: !!r.NOT_NULL,
      dflt: normalizeDefault(r.DEFAULT_SOURCE),
      check: (r.CHECK_SOURCE ?? "").trim() || undefined,
    })),
    views: ((viewsResult?.rows ?? []) as any[]).map(r => ({
      name: display(r.SCHEMA_NAME, r.VIEW_NAME),
      source: r.VIEW_SOURCE ?? "",
    })),
    procedures: ((proceduresResult?.rows ?? []) as any[]).map(r => {
      const name = display(r.SCHEMA_NAME, r.PROCEDURE_NAME);
      return {
        name,
        source: r.PROCEDURE_SOURCE ?? "",
        parameters: parametersByProcedure.get(name) ?? [],
      };
    }),
    triggers: ((triggersResult?.rows ?? []) as any[]).map(r => ({
      name: display(r.SCHEMA_NAME, r.TRIGGER_NAME),
      table: r.TABLE_NAME ? display(r.SCHEMA_NAME, r.TABLE_NAME) : "",
      inactive: !!r.INACTIVE,
      type: r.TRIGGER_TYPE ?? 0,
      source: r.TRIGGER_SOURCE ?? "",
    })),
    generators: ((generatorsResult?.rows ?? []) as any[]).map(r => display(r.SCHEMA_NAME, r.GENERATOR_NAME)),
    exceptions: ((exceptionsResult?.rows ?? []) as any[]).map(r => ({ name: display(r.SCHEMA_NAME, r.EXCEPTION_NAME), message: r.MESSAGE ?? "" })),
    roles: ((rolesResult?.rows ?? []) as any[]).map(r => ({ name: r.ROLE_NAME.trim() })),
    users: ((usersResult?.rows ?? []) as any[]).map(r => ({ name: r.USER_NAME.trim() })),
    pkConstraintNames,
  };
}

/**
 * Extract: reads the connected schema and writes it out as one .sql file per table/view/
 * procedure/trigger/generator under a folder the user picks, plus a firebird.project.json
 * manifest recording a dependency-safe file order — Phase 1 of the design doc. Domains, roles,
 * exceptions, and users are out of scope for this pass (see the design doc's "explicitly
 * deferred" section). Also writes firebird.project-snapshot.json — the same ProjectInput, raw —
 * so Publish can later diff this exact point-in-time snapshot against a live target without
 * needing to re-parse the generated .sql files or reconnect to this source database.
 */
export async function runExtractProject(connectionOptions: ConnectionOptions): Promise<void> {
  const folders = await window.showOpenDialog({
    title: "Select a Destination Folder for the Extracted Project",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!folders || folders.length === 0) {
    return;
  }
  const destFolder = folders[0].fsPath;

  let input: ProjectInput;
  try {
    input = await fetchProjectSnapshot(connectionOptions);
  } catch (err: any) {
    logger.error(`Database Projects extract failed: ${err?.message ?? err}`);
    logger.showError(`Could not read the schema: ${err?.message ?? err}`);
    return;
  }

  if (input.graph.tables.length === 0 && input.views.length === 0 && input.procedures.length === 0
    && input.triggers.length === 0 && input.generators.length === 0 && input.domains.length === 0
    && input.exceptions.length === 0 && input.roles.length === 0 && input.users.length === 0) {
    logger.showError("No objects found in this database — nothing to extract.");
    return;
  }

  const files = buildProjectFiles(input);
  for (const file of files) {
    const fullPath = join(destFolder, ...file.path.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
  }
  await writeFile(join(destFolder, SNAPSHOT_FILE_NAME), JSON.stringify(input, null, 2), "utf8");

  window.showInformationMessage(`Extracted ${files.length - 1} object(s) to ${destFolder}.`, "Reveal in Explorer").then(sel => {
    if (sel === "Reveal in Explorer") {
      commands.executeCommand("revealFileInOS", Uri.file(join(destFolder, MANIFEST_FILE_NAME)));
    }
  });
}

/**
 * Build: reads an existing project folder's manifest and concatenates its files, in the order the
 * manifest recorded at Extract time, into one reviewable script — Phase 2 of the design doc.
 * Never executed automatically; opened in an editor like every other generated DDL in this
 * extension.
 */
export async function runBuildProject(): Promise<void> {
  const folders = await window.showOpenDialog({
    title: "Select a Database Project Folder to Build",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!folders || folders.length === 0) {
    return;
  }
  const projectFolder = folders[0].fsPath;

  let manifest: { files: string[] };
  try {
    const manifestText = await readFile(join(projectFolder, MANIFEST_FILE_NAME), "utf8");
    manifest = JSON.parse(manifestText);
  } catch (err: any) {
    logger.showError(`Could not read ${MANIFEST_FILE_NAME} in ${projectFolder}: ${err?.message ?? err}`);
    return;
  }

  const sections: string[] = [];
  for (const relativePath of manifest.files ?? []) {
    try {
      const content = await readFile(join(projectFolder, ...relativePath.split("/")), "utf8");
      sections.push(`-- ${relativePath}\n${content.trim()}`);
    } catch (err: any) {
      logger.error(`Database Projects build: could not read ${relativePath}: ${err?.message ?? err}`);
      logger.showError(`Could not read ${relativePath} — check the project folder for missing files.`);
      return;
    }
  }

  const script = sections.join("\n\n");
  const doc = await workspace.openTextDocument({ content: script, language: "sql" });
  await window.showTextDocument(doc, ViewColumn.Beside);
  logger.showInfo(`Built a ${manifest.files?.length ?? 0}-file deployable script. Review it, then run it against your target database.`);
}

/**
 * Publish/migrate — Phase 3 of the design doc. Reads a project's saved firebird.project-snapshot.json
 * (written by Extract), picks a target connection from the saved list, fetches that connection's
 * live schema into the same ProjectInput shape, diffs the two, and opens an executable migration
 * script for review. Never executed automatically — this only ever opens the script in an editor;
 * running it against the target database is a separate, explicit step for the user.
 */
export async function runPublishProject(context: ExtensionContext): Promise<void> {
  const folders = await window.showOpenDialog({
    title: "Select a Database Project Folder to Publish",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  if (!folders || folders.length === 0) {
    return;
  }
  const projectFolder = folders[0].fsPath;

  let sourceSnapshot: ProjectInput;
  try {
    const snapshotText = await readFile(join(projectFolder, SNAPSHOT_FILE_NAME), "utf8");
    sourceSnapshot = JSON.parse(snapshotText);
  } catch (err: any) {
    logger.showError(`Could not read ${SNAPSHOT_FILE_NAME} in ${projectFolder} — re-extract this project with the current version of Firebird Studio to generate it. (${err?.message ?? err})`);
    return;
  }

  const savedConnections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
  if (!savedConnections || Object.keys(savedConnections).length === 0) {
    logger.showError("No saved connections found — add a target connection first.");
    return;
  }
  const items = Object.values(savedConnections).map(c => ({ label: getConnectionLabel(c), detail: c.id, conn: c }));
  const targetPick = await window.showQuickPick(items, { placeHolder: "Select the TARGET database to publish to" });
  if (!targetPick) {
    return;
  }

  const includeDropsPick = await window.showQuickPick(
    [
      { label: "No", description: "Only additive/modifying changes (default, safer)" },
      { label: "Yes", description: "Also drop objects present in the target but not in the project — DESTRUCTIVE" },
    ],
    { placeHolder: "Include DROP statements for objects only in the target database?" }
  );
  if (!includeDropsPick) {
    return;
  }

  try {
    const password = await CredentialStore.getPassword(targetPick.conn.id);
    const targetConnection = { ...targetPick.conn, password: password ?? "" };

    const targetSnapshot = await fetchProjectSnapshot(targetConnection);
    const diff = diffProjects(sourceSnapshot, targetSnapshot);
    const script = buildPublishScript(diff, targetSnapshot, { includeDrops: includeDropsPick.label === "Yes" });

    const doc = await workspace.openTextDocument({ content: script, language: "sql" });
    await window.showTextDocument(doc, ViewColumn.Beside);
    logger.showInfo(`Publish script generated for ${targetPick.label}. Review it carefully, then run it yourself against the target database.`);
  } catch (err: any) {
    logger.error(`Database Projects publish failed: ${err?.message ?? err}`);
    logger.showError(`Could not generate the publish script: ${err?.message ?? err}`);
  }
}

/**
 * "Generate Migration Script" (docs/roadmap/schema-diff-migration-script.md) — the same
 * diff-and-script machinery runPublishProject() above uses (fetchProjectSnapshot() +
 * diffProjects() + buildPublishScript()), but for two *live connections* instead of a saved
 * project snapshot vs. one live connection. No new diffing/DDL-generation logic at all: the
 * roadmap doc originally proposed converting schema-diff.ts's own SchemaDiffResult (used by the
 * separate, existing firebird.schemaDiff text-report command) into a PublishDiff, but
 * SchemaDiffResult's SchemaSnapshot turned out to be missing everything PublishDiff/
 * buildPublishScript() actually need beyond bare table/column names and types — view/procedure/
 * trigger *source text* (SchemaSnapshot only ever fetched their names), foreign keys, domains,
 * generators, exceptions, roles, and users. fetchProjectSnapshot() already fetches all of that
 * directly from a live connection into exactly the ProjectInput shape diffProjects() consumes, so
 * reusing it here needed zero conversion code, unlike the SchemaDiffResult path that would have.
 * A source/target picker distinguishes this from schemaDiff's own — that command's is
 * intentionally not reused here, to keep both commands independent (see the roadmap doc for why).
 */
export async function runGenerateMigrationScript(context: ExtensionContext): Promise<void> {
  const savedConnections = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);
  if (!savedConnections || Object.keys(savedConnections).length < 2) {
    logger.showError("You need at least two saved connections to generate a migration script.");
    return;
  }

  const items = Object.values(savedConnections).map(c => ({ label: getConnectionLabel(c), detail: c.id, conn: c }));
  const sourcePick = await window.showQuickPick(items, { placeHolder: "Select the SOURCE database (the one to migrate FROM)" });
  if (!sourcePick) {
    return;
  }
  const targetItems = items.filter(i => i.detail !== sourcePick.detail);
  const targetPick = await window.showQuickPick(targetItems, { placeHolder: "Select the TARGET database (the one to bring in line with source)" });
  if (!targetPick) {
    return;
  }

  const includeDropsPick = await window.showQuickPick(
    [
      { label: "No", description: "Only additive/modifying changes (default, safer)" },
      { label: "Yes", description: "Also drop objects present in the target but not in the source — DESTRUCTIVE" },
    ],
    { placeHolder: "Include DROP statements for objects only in the target database?" }
  );
  if (!includeDropsPick) {
    return;
  }

  try {
    const [sourcePassword, targetPassword] = await Promise.all([
      CredentialStore.getPassword(sourcePick.conn.id),
      CredentialStore.getPassword(targetPick.conn.id),
    ]);
    const sourceConnection = { ...sourcePick.conn, password: sourcePassword ?? "" };
    const targetConnection = { ...targetPick.conn, password: targetPassword ?? "" };

    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      fetchProjectSnapshot(sourceConnection),
      fetchProjectSnapshot(targetConnection),
    ]);

    const diff = diffProjects(sourceSnapshot, targetSnapshot);
    const script = buildPublishScript(diff, targetSnapshot, { includeDrops: includeDropsPick.label === "Yes" });

    const doc = await workspace.openTextDocument({ content: script, language: "sql" });
    await window.showTextDocument(doc, ViewColumn.Beside);
    logger.showInfo(`Migration script generated: ${sourcePick.label} → ${targetPick.label}. Review it carefully, then run it yourself against the target database.`);
  } catch (err: any) {
    logger.error(`Generate Migration Script failed: ${err?.message ?? err}`);
    logger.showError(`Could not generate the migration script: ${err?.message ?? err}`);
  }
}


/** Walks up from `start` looking for the project manifest; returns the folder holding it. */
async function findProjectRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    try {
      await readFile(join(dir, MANIFEST_FILE_NAME), "utf8");
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }
}

/** Every `.sql` file in the project, keyed by its project-relative, forward-slashed path. */
async function readProjectSqlFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.toLowerCase().endsWith(".sql")) {
        found.set(relative(root, full).split(sep).join("/"), await readFile(full, "utf8"));
      }
    }
  }
  await walk(root);
  return found;
}

/**
 * Moves one object's `.sql` file into another schema's folder and requalifies its CREATE header,
 * adapted from SQL Database Projects 1.7.0's Move to Schema.
 *
 * A Database Project is schema-as-code, so this is a declaration rather than an operation on a
 * server: the object is recorded as belonging to the target schema, and Publish is what reconciles
 * a live database against that. Said plainly in the confirmation, because "move" in a database
 * context otherwise sounds like it relocates data.
 */
export async function runMoveToSchema(target?: Uri): Promise<void> {
  const uri = target ?? window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    logger.showError("Open the object's .sql file in a Database Project first, or right-click it in the Explorer.");
    return;
  }

  const root = await findProjectRoot(dirname(uri.fsPath));
  if (!root) {
    logger.showError(`No ${MANIFEST_FILE_NAME} found above this file — Move to Schema works inside an extracted Database Project.`);
    return;
  }

  const relativePath = relative(root, uri.fsPath).split(sep).join("/");
  const parsed = parseObjectPath(relativePath);
  if (!parsed) {
    // Refusing loudly beats moving a role into a schema Firebird cannot put it in.
    logger.showError(`${relativePath} is not a schema-scoped project object. Roles, users, the foreign-key script and the manifest are database-wide and cannot belong to a schema.`);
    return;
  }

  // Offer the schemas the project already has, so a move usually needs no typing.
  const contents = await readProjectSqlFiles(root);
  const existing = [...new Set(
    [...contents.keys()].map(p => parseObjectPath(p)?.schema).filter((x): x is string => !!x)
  )].sort();

  const DEFAULT_LABEL = "$(home) Default schema (no schemas/ folder)";
  const NEW_LABEL = "$(add) New schema…";
  const picked = await window.showQuickPick(
    [
      ...existing.filter(sc => sc !== parsed.schema).map(sc => ({ label: sc, description: `schemas/${sc}/${parsed.category}/` })),
      ...(parsed.schema ? [{ label: DEFAULT_LABEL, description: `${parsed.category}/` }] : []),
      { label: NEW_LABEL, description: "type a schema name" },
    ],
    { title: `Move ${parsed.name} to schema`, placeHolder: parsed.schema ? `Currently in ${parsed.schema}` : "Currently in the default schema" }
  );
  if (!picked) {
    return;
  }

  let targetSchema: string | undefined;
  if (picked.label === NEW_LABEL) {
    const typed = await window.showInputBox({
      title: "Target schema name",
      prompt: `${parsed.name} will be recorded as belonging to this schema when the project is next published.`,
      validateInput: v => (v.trim() ? undefined : "A schema name is required."),
    });
    if (!typed) {
      return;
    }
    targetSchema = typed.trim();
  } else if (picked.label !== DEFAULT_LABEL) {
    targetSchema = picked.label;
  }

  const newRelative = buildObjectPath(parsed, targetSchema);
  if (newRelative === relativePath) {
    logger.showInfo(`${parsed.name} is already there.`);
    return;
  }

  const newFull = join(root, ...newRelative.split("/"));
  try {
    await readFile(newFull, "utf8");
    logger.showError(`${newRelative} already exists — move or delete it first.`);
    return;
  } catch {
    // Nothing there, which is what we want.
  }

  try {
    await mkdir(dirname(newFull), { recursive: true });
    await writeFile(newFull, requalifyDdl(contents.get(relativePath) ?? "", parsed.category, targetSchema), "utf8");
    await rm(uri.fsPath);

    // Keep the manifest's order: Build concatenates in it, and that order is dependency-safe.
    const manifestPath = join(root, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (Array.isArray(manifest.files)) {
      manifest.files = applyMoveToManifestFiles(manifest.files, relativePath, newRelative);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
  } catch (err: any) {
    logger.error(`Move to Schema failed: ${err?.message ?? err}`);
    logger.showError(`Could not move ${parsed.name}: ${err?.message ?? err}`);
    return;
  }

  await window.showTextDocument(Uri.file(newFull), { preview: false });

  // References from other files are deliberately not rewritten, so say which ones to look at
  // rather than letting the move look more complete than it is.
  const referencing = findReferencingFiles(contents, parsed.name, relativePath);
  const where = targetSchema ? `schema ${targetSchema}` : "the default schema";
  if (referencing.length > 0) {
    logger.showWarn(
      `${parsed.name} now belongs to ${where}. ${referencing.length} other file(s) still refer to it by name and were not changed: ${referencing.slice(0, 5).join(", ")}${referencing.length > 5 ? ", …" : ""}`
    );
  } else {
    logger.showInfo(`${parsed.name} now belongs to ${where}. Publish the project to apply it to a database.`);
  }
}

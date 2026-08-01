/**
 * Pure schema-as-code model for the Database Projects feature (Extract + Build). No vscode/fs/
 * Driver dependency — unit-testable without a database, matching schema-graph.ts's/openapi-spec.ts's
 * own convention. See docs/roadmap/database-projects.md for the overall design and known gaps.
 */

import { SchemaGraph, SchemaTable, SchemaColumn, SchemaRelationship } from "../schema-designer/schema-graph";
import { escapeSqlLiteral } from "../shared/queries";

/**
 * One input or output parameter of a procedure, from getAllProcedureParametersQuery(). Shares
 * columnTypeToDDL()'s type/length/subType/precision/scale shape with SchemaColumn so the same
 * NUMERIC/DECIMAL-aware DDL-type reconstruction works for both columns and parameters.
 */
export interface ProcedureParameter {
  name: string;
  direction: "in" | "out";
  type: string;
  length: number;
  subType?: number;
  precision?: number;
  scale?: number;
}

export interface ProcedureSource {
  name: string;
  /** Firebird 6+ only: the name minus a redundant default-schema prefix, used for file names. */
  displayName?: string;
  source: string;
  /**
   * Input/output parameters, in declaration order — RDB$PROCEDURE_SOURCE excludes the parameter
   * list and RETURNS clause entirely (confirmed directly against a live server), so this is the
   * only way to reconstruct a parameterized procedure's DDL. Optional/defaults to empty for
   * callers (e.g. older cached snapshots) that predate this field; a parameterless procedure is
   * unaffected either way.
   */
  parameters?: ProcedureParameter[];
}

export interface TriggerSource {
  name: string;
  /** Firebird 6+ only: the name minus a redundant default-schema prefix, used for file names. */
  displayName?: string;
  table: string;
  inactive: boolean;
  /** RDB$TRIGGER_TYPE — simple single-event encoding only (1-6); see describeTriggerType(). */
  type: number;
  source: string;
}

/**
 * Decodes RDB$TRIGGER_TYPE's simple single-event encoding into the BEFORE/AFTER <event> clause
 * CREATE TRIGGER needs. Firebird also supports combined multi-event triggers (a different, more
 * complex bitmask-based encoding) — out of scope here, matching the pre-existing tree tooltip's
 * own scope (see the identical switch this replaces in src/nodes/node-trigger.ts).
 */
export function describeTriggerType(type: number): string {
  switch (type) {
    case 1: return "BEFORE INSERT";
    case 2: return "AFTER INSERT";
    case 3: return "BEFORE UPDATE";
    case 4: return "AFTER UPDATE";
    case 5: return "BEFORE DELETE";
    case 6: return "AFTER DELETE";
    default: return `TYPE ${type}`;
  }
}

export interface ViewSource {
  name: string;
  /** Firebird 6+ only: the name minus a redundant default-schema prefix, used for file names. */
  displayName?: string;
  source: string;
}

/**
 * From getDomainsQuery(). Shares columnTypeToDDL()'s type/length/subType/precision/scale shape
 * with SchemaColumn/ProcedureParameter, same reason as those two.
 */
export interface DomainSource {
  name: string;
  type: string;
  length: number;
  subType?: number;
  precision?: number;
  scale?: number;
  notNull: boolean;
  dflt?: string;
  /**
   * Already includes its own "CHECK (...)" wrapper (e.g. "CHECK (VALUE >= 0)") — RDB$VALIDATION_SOURCE
   * comes back that way already, confirmed directly against a live server; see getDomainsQuery()'s
   * doc comment. Undefined when the domain has no CHECK constraint.
   */
  check?: string;
}

/** From getRolesQuery(). Firebird roles have no other extractable properties — GRANT/membership migration is out of scope, see docs/roadmap/database-projects.md. */
export interface RoleSource {
  name: string;
}

/** From getExceptionsQuery(). */
export interface ExceptionSource {
  name: string;
  message: string;
}

/** From getUsersQuery() (SEC$USERS) — name only. Firebird's security database stores password hashes, never a recoverable plaintext value, so a user's password can't be extracted or migrated; see buildUserCreateDDL(). */
export interface UserSource {
  name: string;
}

export interface ProjectInput {
  graph: SchemaGraph;
  domains: DomainSource[];
  procedures: ProcedureSource[];
  triggers: TriggerSource[];
  views: ViewSource[];
  generators: string[];
  exceptions: ExceptionSource[];
  roles: RoleSource[];
  users: UserSource[];
  /** Table name -> primary key constraint name, from getAllPrimaryKeyConstraintNamesQuery(). Needed by publish-model.ts to DROP CONSTRAINT a changing PK by its real name — Firebird has no "DROP PRIMARY KEY" shorthand (confirmed directly against a live server). */
  pkConstraintNames: Record<string, string>;
}

export interface ProjectFile {
  /** Relative to the project's destination folder, forward-slash separated. */
  path: string;
  content: string;
}

export const MANIFEST_FILE_NAME = "firebird.project.json";
const FOREIGN_KEYS_FILE = "foreign-keys.sql";

/**
 * Reconstructs a column's DDL type from getSchemaColumnsQuery()'s bare Firebird type name +
 * length, or — for a NUMERIC/DECIMAL column — from RDB$FIELD_SUB_TYPE/PRECISION/SCALE instead,
 * since NUMERIC/DECIMAL are stored as an underlying INTEGER/BIGINT/DOUBLE type in RDB$FIELDS with
 * no trace of the declared precision/scale in the bare type name alone. Confirmed directly
 * against a live Firebird server (not assumed): RDB$FIELD_SUB_TYPE is 1 for NUMERIC, 2 for
 * DECIMAL, 0/null for a plain (non-fixed-point) column; RDB$FIELD_SCALE is negative, so decimal
 * places = -scale. Exported for testing.
 *
 * Narrowed to just the fields it actually reads (not the full SchemaColumn) so ProcedureParameter
 * — which has no name/notNull/isPrimaryKey/dflt concept — can reuse it too.
 */
export function columnTypeToDDL(column: Pick<SchemaColumn, "type" | "length" | "subType" | "precision" | "scale">): string {
  if ((column.subType === 1 || column.subType === 2) && column.precision) {
    const kind = column.subType === 1 ? "NUMERIC" : "DECIMAL";
    const scale = column.scale ? -column.scale : 0;
    return `${kind}(${column.precision},${scale})`;
  }

  switch (column.type) {
    case "VARCHAR":
      return `VARCHAR(${column.length || 1})`;
    case "CHAR":
      return `CHAR(${column.length || 1})`;
    case "CSTRING":
      // Not a valid column type in DDL (it's a parameter/host-variable type) — best-effort VARCHAR.
      return `VARCHAR(${column.length || 1})`;
    case "INT64":
      return "BIGINT";
    case "DOUBLE":
    case "D_FLOAT":
      return "DOUBLE PRECISION";
    case "BLOB":
    case "SMALLINT":
    case "INTEGER":
    case "FLOAT":
    case "DATE":
    case "TIME":
    case "TIMESTAMP":
      return column.type;
    default:
      return "VARCHAR(255)";
  }
}

/** Exported for testing. */
export function buildTableCreateDDL(table: SchemaTable): string {
  const lines = table.columns.map(col => {
    const parts = [`  ${col.name} ${columnTypeToDDL(col)}`];
    if (col.dflt) {
      parts.push(`DEFAULT ${col.dflt}`);
    }
    if (col.notNull) {
      parts.push("NOT NULL");
    }
    return parts.join(" ");
  });

  const pkColumns = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);
  if (pkColumns.length > 0) {
    lines.push(`  PRIMARY KEY (${pkColumns.join(", ")})`);
  }

  return `CREATE TABLE ${table.name} (\n${lines.join(",\n")}\n);`;
}

/** Exported for testing. Firebird has no composite-FK support in SchemaRelationship today (one column pair per relationship — see schema-graph.ts). */
export function buildForeignKeyDDL(rel: SchemaRelationship): string {
  return `ALTER TABLE ${rel.table} ADD CONSTRAINT ${rel.constraintName} FOREIGN KEY (${rel.column}) REFERENCES ${rel.refTable} (${rel.refColumn});`;
}

/**
 * CREATE OR ALTER is used for procedures/triggers/views (not tables, which have no such syntax)
 * so a project's files are safe to (re)run against either a fresh database or one that already
 * has the object.
 *
 * RDB$TRIGGER_SOURCE/RDB$VIEW_SOURCE already contain everything after the object's name (ACTIVE
 * ... AS ... body, or just the SELECT) — but RDB$PROCEDURE_SOURCE, unlike triggers, **never**
 * includes the "AS" keyword, confirmed directly against a live server across three shapes
 * (no params, params+RETURNS, and a bare DECLARE section): it always starts right at BEGIN or
 * DECLARE. A prior comment here claimed otherwise ("already contain ... AS ... confirmed against
 * NodeProcedure#editProcedure()") — that claim was never actually exercised by execution, only by
 * a human reviewing an opened scaffold, so the missing "AS" went unnoticed until Publish/migrate
 * (Phase 3) actually ran the generated script and Firebird rejected it as a syntax error at
 * "BEGIN". NodeProcedure#editProcedure() has the same bug, fixed alongside this.
 *
 * Each of these three ends with an explicit trailing ";" (unlike the raw RDB$*_SOURCE text, which
 * never has one) — also found necessary while building Publish/migrate: without it, several of
 * these concatenated together with no SET TERM (as buildPublishScript() does) have no way for
 * src/shared/sql-splitter.ts to know where one CREATE OR ALTER ends and the next object's DDL
 * begins once the PSQL block's BEGIN/END depth returns to 0 — it just keeps accumulating into one
 * oversized "statement" until it finds the next real ";", silently merging unrelated objects'
 * DDL together. buildTableCreateDDL()/buildForeignKeyDDL() already ended with ";"; this brings
 * the PSQL-body builders in line with that same convention.
 */
/** Renders a procedure's `(name TYPE, ...)` input list or `RETURNS (name TYPE, ...)` output list — empty string if there are none of that direction. */
function buildParameterListDDL(parameters: ProcedureParameter[], direction: "in" | "out"): string {
  const matching = parameters.filter(p => p.direction === direction);
  if (matching.length === 0) {
    return "";
  }
  const list = matching.map(p => `${p.name} ${columnTypeToDDL(p)}`).join(", ");
  return direction === "in" ? `(${list})` : `RETURNS (${list})`;
}

/**
 * Renders the full `(in params...) \n RETURNS (out params...)` header (either half omitted if
 * empty), or "" if there are no parameters at all — shared by buildProcedureCreateDDL() and
 * NodeProcedure#editProcedure()'s ALTER PROCEDURE scaffold. Unlike ALTER TRIGGER (which only needs
 * a body to change behavior, confirmed live), a plain ALTER PROCEDURE genuinely requires
 * re-specifying the full parameter list even for a body-only edit — also confirmed live: omitting
 * it makes every parameter "unknown" inside the new body, since ALTER PROCEDURE redefines the
 * signature too, defaulting to none unless given.
 */
export function buildProcedureParameterHeader(parameters: ProcedureParameter[]): string {
  const inputList = buildParameterListDDL(parameters, "in");
  const returnsList = buildParameterListDDL(parameters, "out");
  return [inputList, returnsList].filter(Boolean).join("\n");
}

export function buildProcedureCreateDDL(procedure: ProcedureSource): string {
  const header = buildProcedureParameterHeader(procedure.parameters ?? []);
  const headerPart = header ? `\n${header}` : "";
  return `CREATE OR ALTER PROCEDURE ${procedure.name}${headerPart}\nAS\n${procedure.source.trim()};`;
}

/**
 * RDB$TRIGGER_SOURCE, unlike RDB$PROCEDURE_SOURCE, already includes "AS" — but it never includes
 * the "FOR <table> {ACTIVE|INACTIVE} {BEFORE|AFTER} <event>" header CREATE TRIGGER requires,
 * confirmed directly against a live server. This was a real, pre-existing gap (not introduced
 * while building Publish/migrate, just exposed by it): every trigger Extract/Build/Publish ever
 * reconstructed was missing this header entirely, a syntax error the moment it was actually run —
 * previously unnoticed since Extract's output was only ever manually reviewed, never executed.
 */
export function buildTriggerCreateDDL(trigger: TriggerSource): string {
  const state = trigger.inactive ? "INACTIVE" : "ACTIVE";
  const header = `FOR ${trigger.table} ${state} ${describeTriggerType(trigger.type)}`;
  return `CREATE OR ALTER TRIGGER ${trigger.name}\n${header}\n${trigger.source.trim()};`;
}

export function buildViewCreateDDL(view: ViewSource): string {
  return `CREATE OR ALTER VIEW ${view.name} AS\n${view.source.trim()};`;
}

export function buildGeneratorCreateDDL(name: string): string {
  return `CREATE SEQUENCE ${name};`;
}

/**
 * Firebird has no "CREATE OR ALTER DOMAIN" (confirmed directly against a live server — only
 * PROCEDURE/TRIGGER/VIEW/EXCEPTION support that shorthand); a domain that already exists needs
 * ALTER DOMAIN instead (see buildDomainAlterStatements() in publish-model.ts). This builder is
 * only for a brand-new domain (Extract/Build, and Publish's "new domain" case).
 */
export function buildDomainCreateDDL(domain: DomainSource): string {
  const parts = [`CREATE DOMAIN ${domain.name} AS ${columnTypeToDDL(domain)}`];
  if (domain.dflt) {
    parts.push(`DEFAULT ${domain.dflt}`);
  }
  if (domain.notNull) {
    parts.push("NOT NULL");
  }
  if (domain.check) {
    parts.push(domain.check);
  }
  return `${parts.join(" ")};`;
}

/**
 * Unlike DOMAIN/ROLE, Firebird does support "CREATE OR ALTER EXCEPTION" (confirmed directly
 * against a live server), so this one builder covers both a new exception and a changed message —
 * safe to (re)run against either a fresh database or one that already has it, the same convention
 * buildProcedureCreateDDL()/buildTriggerCreateDDL()/buildViewCreateDDL() already follow.
 */
export function buildExceptionCreateDDL(exception: ExceptionSource): string {
  return `CREATE OR ALTER EXCEPTION ${exception.name} '${escapeSqlLiteral(exception.message)}';`;
}

/** No "CREATE OR ALTER ROLE" exists (confirmed live) and a Firebird role has no other extractable properties to alter anyway — this is only ever emitted for a brand-new role. */
export function buildRoleCreateDDL(role: RoleSource): string {
  return `CREATE ROLE ${role.name};`;
}

/** A generic, reasonably strong placeholder — not meant to ever actually run; see buildUserCreateDDL()'s doc comment. */
const USER_PASSWORD_PLACEHOLDER = "ChangeMe123!";

/**
 * Commented out by design, not just formatted for readability: Firebird's security database
 * stores password hashes, never a recoverable plaintext value, so there is no way to actually
 * extract or preserve a user's real password. Emitting this as a live, executable statement would
 * mean silently creating a real, log-in-capable account with a publicly-known placeholder
 * password the instant someone runs the generated script without reading every line first —
 * exactly the kind of silent, security-relevant side effect this extension's "always show
 * generated DDL for review before running it" convention exists to prevent elsewhere (see e.g.
 * the column-type-change gap noted in the design doc). A commented-out line stays inert even if
 * the rest of a Build/Publish script is run wholesale, while still fully documenting that the
 * user existed and giving the exact statement (name and all) to uncomment, once a real password
 * is filled in, to recreate it.
 */
export function buildUserCreateDDL(user: UserSource): string {
  return `-- CREATE USER ${user.name} PASSWORD '${USER_PASSWORD_PLACEHOLDER}'; -- TODO: set a real password, then uncomment to recreate this user (Firebird cannot export the original password)`;
}

/** Replaces anything not safe in a cross-platform filename with "_" (Firebird identifiers are almost always already filesystem-safe; this guards delimited/quoted exceptions). */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Builds every project file (including the manifest itself, always first) in a dependency-safe
 * order: generators, then domains, then tables, then foreign keys (added only once every table
 * exists), then exceptions, then views, procedures, and triggers, then roles and users — the same
 * order the manifest's "files" list records for Build to concatenate later.
 *
 * Generators specifically must come first, not last (a real, **pre-existing** ordering bug this
 * fix corrects — generators were already emitted dead last, after procedures/triggers, before any
 * of this file's domains/exceptions/roles/users work existed): confirmed directly against a live
 * server that actually *running* a generated project's script fails with "Generator ... is not
 * defined" the moment a trigger body calls `GEN_ID(some_generator, 1)` (a common pattern for an
 * auto-incrementing key, e.g. this exact case) and that generator's own CREATE SEQUENCE hasn't run
 * yet — a table column DEFAULT or a procedure body can reference a generator the same way. This
 * was invisible before Publish/migrate (Phase 3) started *executing* generated scripts instead of
 * only opening them for review, the same way the four bugs documented in
 * docs/roadmap/database-projects.md's "Four real bugs found and fixed" section were.
 *
 * Exceptions specifically must come before procedures/triggers, not just after: confirmed
 * directly against a live server that CREATE PROCEDURE/TRIGGER fails outright ("exception ... not
 * defined") if any exception it raises via an `EXCEPTION name;` statement doesn't already exist —
 * this isn't just a style preference like most of the rest of this ordering. Domains have no such
 * hard requirement here (getSchemaColumnsQuery()'s columns already resolve to a domain's
 * *underlying* base type rather than referencing the domain by name, so a generated CREATE TABLE
 * never actually depends on a domain existing first) but are still placed early as the
 * conventional "define your types before your tables" order. Roles/users have no dependency on or
 * from anything else here, so they're placed last as the least schema-central objects.
 */
export function buildProjectFiles(input: ProjectInput): ProjectFile[] {
  const files: ProjectFile[] = [];

  input.generators.forEach(name => {
    files.push({ path: `generators/${sanitizeFileName(name)}.sql`, content: buildGeneratorCreateDDL(name) });
  });

  input.domains.forEach(domain => {
    files.push({ path: `domains/${sanitizeFileName(domain.name)}.sql`, content: buildDomainCreateDDL(domain) });
  });

  input.graph.tables.forEach(table => {
    // File named after the *display* name, DDL written with the qualified one. On a single-schema
    // Firebird 6 database that keeps `tables/ORDERS.sql` rather than renaming every file in an
    // existing project to `PUBLIC.ORDERS.sql`, while a second schema still gets its own file
    // (`SALES.ORDERS.sql`). The content is what has to be unambiguous, and `buildTableCreateDDL()`
    // already writes `CREATE TABLE PUBLIC.ORDERS` from the qualified identity.
    const fileName = sanitizeFileName(table.displayName ?? table.name);
    files.push({ path: `tables/${fileName}.sql`, content: buildTableCreateDDL(table) });
  });

  if (input.graph.relationships.length > 0) {
    const fkSql = input.graph.relationships.map(buildForeignKeyDDL).join("\n\n");
    files.push({ path: FOREIGN_KEYS_FILE, content: fkSql });
  }

  input.exceptions.forEach(exception => {
    files.push({ path: `exceptions/${sanitizeFileName(exception.name)}.sql`, content: buildExceptionCreateDDL(exception) });
  });

  input.views.forEach(view => {
    files.push({ path: `views/${sanitizeFileName(view.displayName ?? view.name)}.sql`, content: buildViewCreateDDL(view) });
  });

  input.procedures.forEach(proc => {
    files.push({ path: `procedures/${sanitizeFileName(proc.displayName ?? proc.name)}.sql`, content: buildProcedureCreateDDL(proc) });
  });

  input.triggers.forEach(trigger => {
    files.push({ path: `triggers/${sanitizeFileName(trigger.displayName ?? trigger.name)}.sql`, content: buildTriggerCreateDDL(trigger) });
  });

  input.roles.forEach(role => {
    files.push({ path: `roles/${sanitizeFileName(role.name)}.sql`, content: buildRoleCreateDDL(role) });
  });

  input.users.forEach(user => {
    files.push({ path: `users/${sanitizeFileName(user.name)}.sql`, content: buildUserCreateDDL(user) });
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: files.map(f => f.path),
  };
  files.unshift({ path: MANIFEST_FILE_NAME, content: JSON.stringify(manifest, null, 2) });

  return files;
}

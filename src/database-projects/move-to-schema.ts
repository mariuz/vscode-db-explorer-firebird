import { sanitizeFileName } from "./project-model";

/**
 * Moving an object between schemas inside an extracted Database Project.
 *
 * A Database Project is schema-as-code: the files declare what the database *should* contain, and
 * Publish reconciles a live database against them. So a move here is a declaration -- "this object
 * belongs in SALES" -- not an operation on a running server, and it takes effect when the project
 * is next published. Nothing in this file touches a database.
 *
 * Adapted from SQL Database Projects 1.7.0's **Move to Schema**, which likewise relocates the
 * object's `.sql` file into the target schema's folder rather than only editing its text.
 */

/** The folder each object category lives under, as `buildProjectFiles()` writes them. */
export const SCHEMA_SCOPED_CATEGORIES = [
  "tables", "views", "procedures", "triggers", "generators", "domains", "exceptions",
] as const;

export type SchemaScopedCategory = typeof SCHEMA_SCOPED_CATEGORIES[number];

/**
 * The DDL keyword that introduces each category's object, for rewriting its own CREATE header.
 * `generators` is `SEQUENCE` because that is what `buildGeneratorCreateDDL()` emits -- Firebird
 * accepts both spellings, but only the emitted one needs matching.
 */
const CATEGORY_KEYWORD: Record<SchemaScopedCategory, string> = {
  tables: "TABLE",
  views: "VIEW",
  procedures: "PROCEDURE",
  triggers: "TRIGGER",
  generators: "SEQUENCE",
  domains: "DOMAIN",
  exceptions: "EXCEPTION",
};

export interface ParsedObjectPath {
  /** Absent for the flat layout, which is what the default schema uses. */
  schema?: string;
  category: SchemaScopedCategory;
  /** The bare object name, without the `.sql` extension. */
  name: string;
}

function isSchemaScoped(category: string): category is SchemaScopedCategory {
  return (SCHEMA_SCOPED_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The inverse of `getObjectPath()`: reads a project-relative path back into the object it names.
 *
 * Returns undefined for anything that is not a schema-scoped object file -- `roles/` and `users/`
 * (Firebird has no schema column on either; `RDB$ROLES` is database-wide), `foreign-keys.sql`, the
 * manifest, and any path that simply is not shaped like a project file. Refusing is the point:
 * offering to move a role into a schema would promise something Firebird cannot represent.
 */
export function parseObjectPath(path: string): ParsedObjectPath | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized.toLowerCase().endsWith(".sql")) {
    return undefined;
  }
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1];
  const name = fileName.slice(0, -".sql".length);
  if (!name) {
    return undefined;
  }

  // schemas/<SCHEMA>/<category>/<NAME>.sql
  if (segments.length === 4 && segments[0] === "schemas") {
    return isSchemaScoped(segments[2])
      ? { schema: segments[1], category: segments[2], name }
      : undefined;
  }
  // <category>/<NAME>.sql
  if (segments.length === 2) {
    return isSchemaScoped(segments[0]) ? { category: segments[0], name } : undefined;
  }
  return undefined;
}

/**
 * Where the object's file lives for a given schema. Passing no schema (or the name of the default
 * schema, which the caller resolves) produces the flat layout, so moving an object back to the
 * default schema restores `tables/ORDERS.sql` rather than leaving `schemas/PUBLIC/tables/ORDERS.sql`
 * behind -- the same asymmetry `getObjectPath()` already encodes, and the reason an existing
 * single-schema project does not churn.
 */
export function buildObjectPath(parsed: ParsedObjectPath, targetSchema?: string): string {
  const file = `${sanitizeFileName(parsed.name)}.sql`;
  return targetSchema
    ? `schemas/${sanitizeFileName(targetSchema)}/${parsed.category}/${file}`
    : `${parsed.category}/${file}`;
}

/** An identifier as Firebird writes it: bare, or delimited in double quotes. */
const IDENTIFIER = '(?:"[^"]*"|[A-Za-z0-9_$]+)';

/**
 * Rewrites the object's own CREATE header to name the target schema, and only that header.
 *
 * Deliberately not a global find-and-replace of the object's name: a table called `ORDERS` may
 * well have a column, a comment or a procedure body mentioning `ORDERS`, and rewriting those would
 * corrupt the file to make one identifier look right. Only the leading
 * `CREATE [OR ALTER] <KEYWORD> [<schema>.]<name>` is touched, which is exactly the identity the
 * file's folder is supposed to agree with.
 *
 * References *to* this object from other files -- the foreign-key script, a trigger's `FOR
 * <table>` clause, a procedure body -- are not rewritten; see `findReferencingFiles()`, which the
 * command uses to tell the user which files it did not touch.
 */
export function requalifyDdl(
  ddl: string, category: SchemaScopedCategory, targetSchema?: string
): string {
  const keyword = CATEGORY_KEYWORD[category];
  const header = new RegExp(
    `(CREATE(?:\\s+OR\\s+ALTER)?\\s+${keyword}\\s+)(${IDENTIFIER}\\s*\\.\\s*)?(${IDENTIFIER})`,
    "i"
  );
  let replaced = false;
  return ddl.replace(header, (match, lead: string, _schema: string | undefined, name: string) => {
    if (replaced) {
      return match;
    }
    replaced = true;
    return `${lead}${targetSchema ? `${targetSchema}.` : ""}${name}`;
  });
}

/**
 * Replaces one path in the manifest's file list, in place, so Build still concatenates the project
 * in its dependency-safe order. Reordering here would silently break a script whose generators must
 * run before the triggers calling `GEN_ID()` on them.
 */
export function applyMoveToManifestFiles(
  files: string[], oldPath: string, newPath: string
): string[] {
  return files.map(f => (f === oldPath ? newPath : f));
}

/**
 * Which other project files mention this object's bare name, so the command can say what it left
 * alone rather than implying the move was complete. Word-boundary matched and case-insensitive,
 * which over-reports rather than under-reports -- a false "check this file too" is a far cheaper
 * mistake than a silent stale reference in a script that will be executed.
 */
export function findReferencingFiles(
  contents: Map<string, string>, objectName: string, excludePath: string
): string[] {
  const needle = new RegExp(`\\b${objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return [...contents.entries()]
    .filter(([path, text]) => path !== excludePath && needle.test(text))
    .map(([path]) => path)
    .sort();
}

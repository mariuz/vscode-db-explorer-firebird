/**
 * Firebird 6 SQL schemas — the pure half.
 *
 * Firebird 6.0 is the first release with SQL schemas (see docs/roadmap/firebird6-schemas.md).
 * Every object now lives in one, `RDB$RELATIONS` and friends gained an `RDB$SCHEMA_NAME` column,
 * and a session resolves unqualified names through a search path defaulting to `PUBLIC, SYSTEM`.
 *
 * The practical consequence for this extension is not cosmetic: on a Firebird 6 database holding
 * both `SALES.ORDERS` and `PUBLIC.ORDERS`, a schema-blind tree shows two identical `ORDERS` nodes
 * and every action on either resolves through the search path — silently operating on whichever
 * one it happens to find first.
 *
 * Everything here is version-gated. `RDB$SCHEMA_NAME` does not exist before Firebird 6, where
 * selecting it is a hard SQL error rather than a graceful degradation, so nothing in this module
 * may be applied without first checking {@link supportsSchemas}.
 */

/** Firebird 6.0 is the first version with SQL schemas at all. */
export function supportsSchemas(engineMajorVersion: number): boolean {
  return engineMajorVersion >= 6;
}

/**
 * The schema unqualified names resolve to first. `PUBLIC` is the default user schema in a new
 * database and the first entry of the default search path (`PUBLIC, SYSTEM`).
 *
 * Deliberately not treated as a constant elsewhere in the codebase: `PUBLIC` can be dropped by the
 * database owner, so anything that needs the *actual* search path must read
 * `RDB$GET_CONTEXT('SYSTEM', 'SEARCH_PATH')` rather than assume this.
 */
export const DEFAULT_SCHEMA = "PUBLIC";

/** Firebird's own metadata schema, which is appended to every search path implicitly. */
export const SYSTEM_SCHEMA = "SYSTEM";

/**
 * How an object should be labelled in the tree.
 *
 * Objects in the default schema keep their bare name — a single-schema database (which is every
 * Firebird 6 database until someone runs `CREATE SCHEMA`) should not suddenly grow a `PUBLIC.`
 * prefix on every node. Anything outside it is qualified, because that is the only thing that
 * tells two same-named tables apart.
 */
export function schemaDisplayName(schema: string | undefined, name: string, defaultSchema = DEFAULT_SCHEMA): string {
  const trimmedName = name.trim();
  const trimmedSchema = schema?.trim();
  if (!trimmedSchema || trimmedSchema === defaultSchema) {
    return trimmedName;
  }
  return `${trimmedSchema}.${trimmedName}`;
}

/**
 * The name to put in generated SQL.
 *
 * Unlike {@link schemaDisplayName} this qualifies *whenever* a schema is known, including the
 * default one: relying on the search path to land on the right object is exactly the failure this
 * whole feature exists to prevent, and an explicitly qualified name costs nothing when it happens
 * to agree with the search path anyway.
 */
export function schemaQualifiedName(schema: string | undefined, name: string): string {
  const trimmedName = name.trim();
  const trimmedSchema = schema?.trim();
  return trimmedSchema ? `${trimmedSchema}.${trimmedName}` : trimmedName;
}

/**
 * Splits `SCHEMA.OBJECT` back into its parts, tolerating an unqualified name.
 *
 * Note this does not attempt to handle Firebird 6's `%` scope specifier or quoted identifiers
 * containing a dot — see the design doc's open questions. It exists for round-tripping names this
 * module produced, not for parsing arbitrary user SQL.
 */
export function splitQualifiedName(qualified: string): { schema?: string; name: string } {
  const trimmed = qualified.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    return { name: trimmed };
  }
  return { schema: trimmed.slice(0, dot), name: trimmed.slice(dot + 1) };
}

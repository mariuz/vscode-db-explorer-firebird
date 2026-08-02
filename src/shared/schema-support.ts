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
 * The search path a *connection* attaches with, given its configured default schema.
 *
 * This mirrors node-firebird's own `buildSchemaSearchPath()` deliberately, because that function is
 * what actually reaches the server: Firebird has no "default schema" attachment parameter, so
 * `defaultSchema` is implemented by putting the schema at the front of `isc_dpb_search_path` and
 * keeping `PUBLIC` behind it as a fallback. Duplicating the rule here rather than inferring it
 * means anything that needs to *predict* name resolution — completion ranking, most of all — agrees
 * with what the session will really do.
 *
 * `SYSTEM` is not listed: the engine appends it whether or not anyone asks, and naming it would
 * suggest the caller controls something they do not.
 *
 * Returns an empty list when no schema is configured — meaning "leave the server's default alone",
 * which is not the same as `['PUBLIC']`. Only {@link effectiveSearchPath} substitutes a default,
 * because only a *reader* of the path needs one.
 *
 * The `PUBLIC` comparison is case-*sensitive*, which looks like an oversight and is not: the point
 * is to predict what node-firebird sends, and it compares exactly the same way. A connection whose
 * `defaultSchema` was hand-written as `public` in `.vscode/firebird.json` really does get
 * `public,PUBLIC` on the wire. {@link searchPathRank} folds case when *reading* the result, so the
 * duplicate ranks as one schema rather than two.
 */
export function connectionSearchPath(defaultSchema?: string): string[] {
  const schema = defaultSchema?.trim();
  if (!schema) {
    return [];
  }
  return schema === DEFAULT_SCHEMA ? [DEFAULT_SCHEMA] : [schema, DEFAULT_SCHEMA];
}

/**
 * The schemas named by the last `SET SEARCH_PATH TO …` statement in `sql`, or `undefined` when
 * there is none.
 *
 * The last one wins because that is what the session ends up with once the whole text has run —
 * matching what **New Query in Schema…** writes at the top of a document.
 *
 * Scope worth being honest about: this is a regex over raw text, so a `SET SEARCH_PATH` inside a
 * comment or a string literal counts, and a quoted identifier containing a comma does not survive.
 * That is acceptable *here specifically* because the only consumer is completion **ranking** — a
 * misread reorders a list, it never changes what a statement does, and the fallback is the
 * connection's own default. Do not reuse this to decide what a query will actually resolve to.
 */
export function parseSearchPath(sql: string): string[] | undefined {
  const re = /\bSET\s+SEARCH_PATH\s+TO\s+([^;\r\n]+)/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    last = m;
  }
  if (!last) {
    return undefined;
  }
  const schemas = last[1]
    .split(",")
    .map(part => part.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);
  return schemas.length ? schemas : undefined;
}

/**
 * The search path a given document's statements will run under: what the document says, else what
 * the connection was opened with, else Firebird's own default.
 *
 * The document wins over the connection because a `SET SEARCH_PATH` in the text executes after the
 * attach and overrides it for the rest of the session — which is exactly what **New Query in
 * Schema…** relies on.
 */
export function effectiveSearchPath(documentText: string, connectionPath: string[] = []): string[] {
  const fromDocument = parseSearchPath(documentText);
  if (fromDocument) {
    return fromDocument;
  }
  return connectionPath.length ? [...connectionPath] : [DEFAULT_SCHEMA];
}

/**
 * Where a schema sits in the search path — lower sorts first, and anything not on the path sorts
 * after everything that is.
 *
 * Case-insensitive: unquoted identifiers reach the server folded to upper case, so a search path
 * typed as `sales` and a catalogue schema of `SALES` are the same schema.
 */
export function searchPathRank(schema: string | undefined, searchPath: string[]): number {
  const target = schema?.trim().toUpperCase();
  if (!target) {
    return searchPath.length;
  }
  const index = searchPath.findIndex(entry => entry.trim().toUpperCase() === target);
  return index === -1 ? searchPath.length : index;
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

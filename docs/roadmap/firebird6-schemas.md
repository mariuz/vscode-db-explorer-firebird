# Firebird 6 SQL schemas

**Inspired by**: [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql), whose entire object model is schema-aware — the Object Explorer nests *server → database → schema → tables/views/functions/...*, the schema visualizer gives "each schema a distinct color for quick identification" with a legend toggle, IntelliSense "respects `search_path` settings" (1.21.0), and there is a schema-aware **New Query** command that opens an editor with `search_path` pre-configured (1.21.0). Firebird 6.0 is the first Firebird release with SQL schemas at all, so the same class of feature now applies here — and unlike most pgsql-inspired items, this one is not optional polish: **without it, this extension is wrong on a Firebird 6 database that uses more than one schema.**

## Firebird 6's schema model (verified against the engine's own docs)

From [`doc/sql.extensions/README.schemas.md`](https://github.com/FirebirdSQL/firebird/blob/master/doc/sql.extensions/README.schemas.md) in the Firebird source tree:

- `CREATE [OR ALTER] SCHEMA [IF NOT EXISTS] <name> [DEFAULT CHARACTER SET <cs>] [DEFAULT SQL SECURITY {DEFINER | INVOKER}]`; `INFORMATION_SCHEMA` and `DEFINITION_SCHEMA` are reserved names.
- A new `RDB$SCHEMAS` system table (`RDB$SCHEMA_NAME`, `RDB$CHARACTER_SET_NAME`, `RDB$SQL_SECURITY`, `RDB$OWNER_NAME`, `RDB$SYSTEM_FLAG`).
- **An `RDB$SCHEMA_NAME` column added to the system tables this extension queries on nearly every code path** — `RDB$RELATIONS`, `RDB$INDICES`, `RDB$PROCEDURES`, `RDB$FUNCTIONS`, `RDB$TRIGGERS`, and others.
- A per-session **search path**, defaulting to `PUBLIC, SYSTEM`, readable via `RDB$GET_CONTEXT('SYSTEM', 'SEARCH_PATH')`, settable per statement with `SET SEARCH_PATH TO <schema>[, <schema>...]` and per connection with the `isc_dpb_search_path` DPB item.
- `SYSTEM` holds all `RDB$*`/`MON$*` metadata and is implicitly appended to every search path (that is why existing unqualified `RDB$RELATIONS` queries keep working on Firebird 6). `PUBLIC` is the default user schema in a new database and *can* be dropped by the database owner.
- Resolution rules differ by statement kind: `CREATE`/`RECREATE` only ever use the **first** schema in the path; `ALTER`/`DROP`/`SELECT` walk the path in order and bind to the first match.

## Current state in Firebird Studio

**Not started.** The codebase knows Firebird 6 exists but models a database as a flat, single-namespace object list:

- **Every metadata query in `src/shared/queries.ts` (823 lines) is schema-blind.** `getTablesQuery()` is `SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE RDB$VIEW_BLR IS NULL AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)` — no `RDB$SCHEMA_NAME` selected, no schema predicate, no schema in the `ORDER BY`. `grep -rn 'RDB\$SCHEMA' src/` returns **nothing**. On a Firebird 6 database with `SALES.ORDERS` and `HR.ORDERS`, the tree shows two identically-named `ORDERS` nodes, and every downstream action (expand columns, `SELECT *`, Script as Create, Drop, row editing) picks whichever one the search path happens to resolve first — silently operating on the wrong table.
- **The one place that does know**: `src/shared/actual-plan.ts` schema-qualifies `PLG$PROFILER` for Firebird 6 and carries the comment *"Firebird 6.0 (the first version with SQL schema support at all)"*, and it already has a working **`parseEngineMajorVersion()`** (unit-tested in `src/test/actual-plan.test.ts`, including the real `"6.0.0"` string a live FB6 server returns from `RDB$GET_CONTEXT`). That function is the version gate the rest of this feature needs — it exists, it is proven, it is just not consulted anywhere else.
- **Identifier quoting is schema-unaware.** `src/shared/identifier-quoting.ts` and `assertValidIdentifier()` (`src/shared/row-edit.ts`) handle a single identifier; nothing builds or validates a two-part `SCHEMA.OBJECT` name.
- **Downstream consumers all inherit the flat model**: the tree (`src/nodes/`, `NodeDatabase` → category folders → objects), the completion provider's table/column words (`src/language-server/db-words.provider.ts`), the Schema Designer's graph (`schema-graph.ts`, built from `getSchemaColumnsQuery()`/`getForeignKeysQuery()` — note the pre-existing name collision: "schema" there means "the shape of the database", not a SQL schema), `src/script-as/ddl-builders.ts`, `src/schema-diff/`, `src/database-projects/`, and the `get_schema` tool body in `src/shared/db-tools.ts` that feeds both the MCP server and the Copilot LM tools.
- **CI already runs against Firebird 6.** `.github/workflows/vscode-host.yml` installs a Firebird 6 snapshot from tar.gz, and several source comments record behavior "confirmed directly against a live Firebird 6.0 server". So this is testable end to end today, with no new infrastructure.

## Proposed feature

**A version-gated schema dimension threaded through the object model, not a rewrite.** Everything below must be a no-op on Firebird 3/4/5 — those servers have no `RDB$SCHEMAS`, and adding `RDB$SCHEMA_NAME` to a query there is a hard SQL error, not a graceful degradation. The gate is `parseEngineMajorVersion() >= 6`, resolved once per connection (it is already fetched via `RDB$GET_CONTEXT`) and cached alongside the connection, not re-probed per query.

- **Two query variants, one call site.** `queries.ts` functions grow a schema-aware form selected by the cached engine version, rather than every caller branching. The pre-Firebird-6 SQL must stay byte-identical to today's — this is the single largest regression risk in the whole item, and it is why the split belongs in one file behind one flag.
- **A Schemas level in the tree**, between `NodeDatabase` and the existing category folders, shown *only* on Firebird 6+ and *only* when the database has more than the default `PUBLIC` (a single-schema FB6 database should not grow a pointless extra click). `firebird.showSystemObjects` already exists and is the natural toggle for whether `SYSTEM` is listed.
- **Qualified names on every write path.** `SELECT *`, Script as Create/Drop, row editing's `UPDATE`/`INSERT`/`DELETE`, drop/alter actions, and the Table/Schema Designer's generated DDL must emit `SCHEMA.OBJECT` when the engine supports it — never relying on the session search path to land on the right object. This is where `identifier-quoting.ts` grows a two-part builder that quotes each part independently.
- **Search-path awareness for the query editor.** A per-connection default schema (stored on the saved connection, applied via `SET SEARCH_PATH` when the session opens), a **New Query in Schema** tree action that opens an editor already scoped to the schema you right-clicked (pgsql 1.21.0's exact feature), and completion that ranks in-search-path objects above out-of-path ones and qualifies the ones it inserts from another schema.
- **Color-coded schemas in the Schema Designer**, with a legend toggle — pgsql's presentation, and the thing that makes a multi-schema ER diagram readable at all.
- **`CREATE`/`ALTER`/`DROP SCHEMA` tree actions**, plus schema-level grants in the existing privileges viewer.
- **Schema-aware Database Projects and schema-diff**: extract into per-schema folders, and diff schema-qualified so a table moving between schemas reads as a move rather than an unrelated drop-and-create.

## Risks and open questions

- **The scope-specifier `%` syntax.** Firebird 6 introduces a `%` scope specifier to disambiguate `a.b` (schema.table vs. table.column vs. package.routine) — see [firebird#8439](https://github.com/FirebirdSQL/firebird/issues/8439). The SQL linter, formatter, splitter, and completion provider all currently assume `a.b` is unambiguous. Worth confirming the final syntax against a live FB6 server before touching `sql-linter.ts`/`sql-formatter.ts`, the same way the rest of this codebase's FB6 claims were verified.
- **`PUBLIC` is droppable**, so "the default schema" cannot be hardcoded — read the actual search path with `RDB$GET_CONTEXT('SYSTEM','SEARCH_PATH')` instead of assuming.
- **Firebird 6 is not released yet** (this targets the snapshot CI already builds against). Phase 1 is worth doing regardless — it is what stops the tree from being *wrong* — but phases 4–5 should track the final release notes rather than the current snapshot.

## Phase 1a — engine detection and schema-aware tables (done)

The first slice of phase 1, scoped to the Tables category. Verified against a **live Firebird 6.0.0 server** (`RDB$GET_CONTEXT('SYSTEM','ENGINE_VERSION')` = `6.0.0`, `RDB$SCHEMAS` holding `PUBLIC` and `SYSTEM`, search path `"PUBLIC", "SYSTEM"`), with the collision this feature exists for reproduced deliberately: a `SALES` schema created alongside `PUBLIC`, each holding an `ORDERS` table with different columns.

**The bug is now demonstrated rather than asserted.** Against that database:

```
SALES.ORDERS   -> [{"ID":1,"TOTAL":999}]
PUBLIC.ORDERS  -> [{"ID":1,"NOTE":"public-row"}]
ORDERS         -> [{"ID":1,"NOTE":"public-row"}]   <-- what the old code sent
```

The unqualified name the tree used to emit resolves through the search path to `PUBLIC.ORDERS`, so clicking the *other* `ORDERS` node ran against the wrong table and showed the wrong columns, with nothing on screen to indicate it.

What landed:

- **`src/shared/schema-support.ts`** (pure, 16 unit tests): `supportsSchemas()` (>= 6, with 0 — the "could not detect" value — correctly treated as legacy), `schemaDisplayName()` and `schemaQualifiedName()`. The asymmetry between those two is the design: the tree hides a redundant `PUBLIC.` prefix so a single-schema database looks exactly as it did before, while generated SQL qualifies *always*, because leaving it to the search path is the failure above.
- **`src/shared/engine-version.ts`**: the version probe, cached per connection id. Cached per connection rather than globally because one workspace routinely holds connections to servers of different versions, and getting that wrong means sending Firebird 6 SQL to a Firebird 5 server. A failed probe returns 0 and is *not* cached, so a transient failure cannot pin a connection to legacy behaviour for the session.
- **`getTablesQuery(maxTableCount, withSchemas)`**: selects `RDB$SCHEMA_NAME` only when asked. The pre-6 form is byte-identical to what it always emitted — asserted by a test, since `RDB$SCHEMA_NAME` on a pre-6 server is a hard SQL error, not a degradation.
- **`NodeTable`** carries an optional schema: `getTableName()` returns the qualified name (used by Select All Records, Drop Table, and drag-into-editor), `getRelationName()` returns the bare one for metadata lookups that match on `RDB$RELATION_NAME`.

### Phase 1b — schema-filtered column metadata (done)

`tableInfoQuery(tableName, schema?)` now takes an optional schema, and `NodeTable` passes its own at all three call sites (expanding the node, Table Info, and Script as Create). Verified live against the same two-schema database:

```
(no schema, old behaviour) -> ID, NOTE, TOTAL
SALES                      -> ID, TOTAL
PUBLIC                     -> ID, NOTE
```

The old lookup returned the union of both tables' columns — a table that does not exist — and expanding either `ORDERS` node showed it. The index join is scoped to the same schema for the same reason: `RDB$INDICES` carries `RDB$SCHEMA_NAME` on Firebird 6 (confirmed against a live server), so joining on the relation name alone would attach another schema's indexes to these columns. Without a schema the SQL is unchanged, asserted by a test.

### Phase 1c — views, and the two-part identifier guard (done)

Views got the same treatment: `getViewsQuery(withSchemas)`, a schema predicate on `viewColumnsQuery()` and on `getViewDefinitionQuery()`, and an optional schema on `NodeView` feeding its label, `SELECT`, `DROP` and drag identifier. Verified live against two views both named `ACTIVE`:

```
view labels                -> ACTIVE | SALES.ACTIVE
columns for (old behaviour) -> ID, ID, TOTAL, NOTE
columns for SALES           -> ID, TOTAL
columns for PUBLIC          -> ID, NOTE
```

Views were worse than tables: the merged lookup returned a **duplicated** `ID`. `getViewDefinitionQuery()` matters for a different reason — its callers read row 0, so with two same-named views the "Edit View Source" action would show, and let you edit, whichever the server returned first.

**`assertValidIdentifier()` had to learn about two-part names**, and this is the part to be careful with. It is the injection guard for every statement the row-edit builders generate, and its regex rejected the dot — so qualifying a table name would have made row editing fail with `Invalid table name: "SALES.ORDERS"` on exactly the tables this feature exists to address. It now splits on the *first* dot and requires **both** halves to match the same strict rule, so `A.B.C`, `.ORDERS`, `SALES.`, `SALES.ORDERS'` and `ORDERS; DROP TABLE T` are all still rejected — six new tests cover precisely those. The mirrored regex in `extension.ts` deliberately stays single-part: it validates names the user is *creating* (a new index, a new column), where a dot is a mistake rather than a qualification, and its comment now says so instead of claiming the two match.

### Phase 1d — the remaining object categories (done)

Procedures, triggers, generators, domains and exceptions now list schema-aware, completing the read path for every category that *has* a schema. Verified live:

```
procedures  : TOTALS | SALES.TOTALS
generators  : SALES.SEQ1
domains     : SALES.POSAMT
exceptions  : SALES.BOOM
```

Procedures got the full treatment (listing, parameters, body) because they have the same two failure modes tables and views did — verified live, a `TOTALS` procedure in two schemas returned **both** procedures' parameters as if one procedure had them all:

```
params for (old behaviour) -> N, M
params for SALES           -> N
params for PUBLIC          -> M
```

**Roles deliberately need no change.** `RDB$ROLES` is the one system table in this set *without* an `RDB$SCHEMA_NAME` column — checked directly against the live server rather than assumed — because roles are database-wide rather than schema-scoped. Leaving that category alone is correct, not an omission.

Two implementation notes. `NodeTrigger`, `NodeDomain` and `NodeException` receive the whole metadata row rather than a name, so the extra column reaches them without any constructor change — only their label had to learn `schemaDisplayName()`. And the five-times-repeated version probe is now one `schemasSupported()` helper on `NodeDatabase`, so every category asks the same way and the cached lookup happens in one place.

### Phase 1e — foreign keys and generated DDL (done)

The last correctness gap in the paths already made schema-aware. `getForeignKeysQuery()` joined `RDB$RELATION_CONSTRAINTS` and `RDB$INDEX_SEGMENTS` on names alone, and on Firebird 6 those names repeat per schema. With `FK_ORDERS_CUST` (and an identically-named index) present in both `SALES` and `PUBLIC`, verified live:

```
old behaviour (8 rows): ORDERS -> CUST | ORDERS -> CUST | ... (x8)
schema-aware  (2 rows): SALES.ORDERS -> SALES.CUST | PUBLIC.ORDERS -> PUBLIC.CUST
```

Two foreign keys became an eight-row cross product, with no column in the result to tell the duplicates apart. **All four joins** needed scoping, not just the constraint one. The referenced side joins through **`RDB$REF_CONSTRAINTS.RDB$CONST_SCHEMA_NAME_UQ`** rather than the constraint's own schema, because a foreign key may legitimately reference a table in a different schema — that column exists precisely for this, and was found by inspecting the live catalogue rather than guessed.

**Script as Create** now names the table as it actually is (`CREATE TABLE SALES.ORDERS`, not `CREATE TABLE ORDERS`, which would recreate it wherever the search path points), filters foreign keys by schema as well as name, and qualifies each side of a foreign key independently from the row's own `SCHEMA_NAME`/`REF_SCHEMA_NAME`. It infers schema support from `this.schema` being set, which only happens on Firebird 6+, rather than re-probing the version.

### Phase 1f — the Schema Designer's ER graph (done)

`buildSchemaGraph()` keys tables by name, so on Firebird 6 the whole-database diagram merged same-named tables into a single box holding the union of their columns. Verified live, and the numbers show two separate bugs:

```
old behaviour : 5 tables; ORDERS -> ID,ID,ID,ID,ID,ID,ID,ID,TOTAL,TOTAL,NOTE,NOTE,CUST_ID,CUST_ID,CUST_ID,CUST_ID
schema-aware  : 7 tables; SALES.ORDERS -> ID*,TOTAL,CUST_ID | PUBLIC.ORDERS -> ID*,NOTE,CUST_ID
```

The merge was the obvious one. The **duplication** was not: `getSchemaColumnsQuery()` joins `RDB$RELATIONS`, `RDB$FIELDS` and a primary-key subquery over `RDB$RELATION_CONSTRAINTS`/`RDB$INDEX_SEGMENTS`, and every one of those matches on a name that repeats per schema — so each column row multiplied by the number of schemas holding a same-named relation, domain or index. One table's four columns came back as sixteen rows. Scoping all four joins fixes it, exactly as with the foreign-key query.

`buildSchemaGraph()` itself now qualifies from the rows: tables by `SCHEMA_NAME`, and each end of a relationship independently from `SCHEMA_NAME`/`REF_SCHEMA_NAME`, since a foreign key may cross schemas. Rows without a schema keep their bare name, so pre-6 servers and callers that have not opted in are untouched.

**Only the Schema Designer opted in.** `data-api-builder`, `database-projects` and the MCP server also call `buildSchemaGraph()` and still pass no flag, so they behave exactly as before — deliberately, since qualified table names would flow into generated REST specs, project files and agent-visible schema output, each of which deserves its own decision rather than being changed as a side effect.

### What is still missing, precisely
- **No Schemas level in the tree**, which is the rest of phase 1.
- **Data API Builder, Database Projects and the MCP server still build schema-blind graphs** — see phase 1f for why that was left as a deliberate choice rather than swept along. The qualified label is a smaller change that fixes the ambiguity without restructuring the tree; the level is still the better long-term shape.
- Phases 2–5 (full write-path qualification, search-path handling, the designer/diff/projects work) are untouched.

## Suggested phases

1. **Read path**: cache the engine major version per connection (reusing `parseEngineMajorVersion()`), add the schema-aware query variants behind that gate, and surface the Schemas level in the tree. No write-path changes — the tree stops lying first. — **partly done (phase 1a above)**: version cache, schema-aware Tables listing and qualified labels/SQL for tables. The other object categories, schema-filtered column metadata, and the Schemas tree level remain.
2. **Write path**: two-part qualified identifiers in `identifier-quoting.ts`, then thread them through `ddl-builders.ts`, `row-edit.ts`, `selectAllRecordsQuery()`, and the designers' DDL generation.
3. **Search path**: per-connection default schema, `SET SEARCH_PATH` on session open, "New Query in Schema", and search-path-aware completion ranking/qualification.
4. **Presentation and tooling**: color-coded schemas plus legend in the Schema Designer; schema names in `get_schema` for the MCP/LM tools so agent-written SQL is qualified too.
5. **Lifecycle**: `CREATE`/`ALTER`/`DROP SCHEMA` actions, schema-level grants, per-schema folders in Database Projects, and schema-qualified schema-diff.

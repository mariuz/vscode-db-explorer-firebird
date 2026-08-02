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

**The Schema Designer and the AI tools opted in; the rest did not.** `data-api-builder` and `database-projects` also call `buildSchemaGraph()` and still pass no flag, so they behave exactly as before — deliberately, since qualified names would flow into generated REST specs and project files, each of which deserves its own decision.

### Phase 1g — the agent-facing `get_schema` (done)

`shared/db-tools.ts` backs *both* AI transports (the MCP subprocess and the Copilot language-model tools), and its `get_schema` had the same merge. This is the worst place for it: an agent reading a merged table writes SQL against a table that does not exist, and unlike a UI there is nobody to notice the diagram looks odd. Verified live through the real tool body against Firebird 6.0.0:

```
tables the agent sees: PUBLIC.CAP_DEMO, SALES.CUST, PUBLIC.CUST, SALES.ORDERS,
                       PUBLIC.ORDERS, PUBLIC.PW_DIAGRAM_DEMO, PUBLIC.PW_PLAN_DEMO
  SALES.ORDERS  -> ID,TOTAL,CUST_ID
  PUBLIC.ORDERS -> ID,NOTE,CUST_ID
```

Doing this required making `engine-version.ts` free of any `vscode` import — it used the logger, which owns an output channel, and `db-tools.ts` runs inside the MCP subprocess, which is a plain Node process. The probe now swallows a failed lookup rather than logging it, and takes a connection *id* rather than a whole `ConnectionOptions`, which also removed its last interface dependency.

Two things the tests had to learn. The version probe is a third statement on the same connection, so the existing "both metadata queries run on one connection" assertion became "three statements, one connection". And because the version is cached per connection id, a test reporting 5.0.1 pinned the shared fake connection to legacy behaviour for every test after it — `clearEngineVersionCache()` in a `setup()` hook keeps them order-independent, which is exactly what that seam exists for.

### Phase 1h — display name vs identity in the graph (done)

Phase 1g left every Schema Designer box reading `PUBLIC.X` on a single-schema database, because `buildSchemaGraph()` qualifies unconditionally. Both needs are real and they are not the same need, so the graph now carries both:

```
diagram labels : CAP_DEMO, SALES.CUST, CUST, SALES.ORDERS, ORDERS, ...
DDL identities : PUBLIC.CAP_DEMO, SALES.CUST, PUBLIC.CUST, SALES.ORDERS, PUBLIC.ORDERS, ...
```

`name` stays the qualified identity — it keys positions, relationship endpoints and focus matching, and it is what generated DDL uses, where deferring to the search path is the whole bug. `displayName` is what the box shows, and is only set when it would actually differ, so every existing consumer that reads `name` is untouched and a pre-6 database produces neither field. The webview's `tableTitle()` is the one place that chooses, used for both the header text and the width measurement so the box is sized to what it displays.

### Phase 1i — the Data API Builder (done)

The generator now reads a schema-aware graph, and the live before/after is the clearest illustration of what merging costs downstream:

```
old behaviour : /orders, /orders/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}/{ID}
schema-aware  : /sales.orders, /sales.orders/{ID}, /orders, /orders/{ID}
```

`SALES.ORDERS` and `PUBLIC.ORDERS` merged into one table carrying eight duplicated `ID` primary-key columns, and the by-primary-key route is built from them — so the spec published a path repeating the same parameter eight times, for a table that does not exist.

Naming uses the split from phase 1h: routes and schema components take `displayName`, so a single-schema database keeps `/orders` rather than gaining a redundant `/public.orders`, while `SALES.ORDERS` stays distinguishable as `/sales.orders`. One `publishedName()` accessor covers every place a table's name reaches the generated document.

### What is still missing, precisely

> This list was written when phase 1i was the newest section here, and every item on it has since
> been done — Database Projects in phase 2b, the designer's redundant `PUBLIC.` prefix in phase 1h,
> and phases 2–5, which have their own sections below. It is replaced by what follows. Kept as a
> heading because a stale "what is missing" list sitting above the sections that contradict it is
> worse than none: it reads as authoritative, and it is the first thing anyone checks.

Three things remain, in the order they are worth doing:

- **Search-path-aware completion ranking.** Completion distinguishes same-named tables across schemas and inserts qualified names — done in `8d56afa`, which has no phase section here — but it does not *rank* them — a table in the session's search path should be offered before one that is not. Self-contained, and the only remaining read-path gap.
- **Per-schema project folders** (`schemas/SALES/tables/…`) for Database Projects. Phase 2b makes the current per-object layout correct, so this is a tidier long-term shape rather than a fix; it is a layout decision that will churn existing projects, which is why it is not a flag flip.
- ~~**A per-connection default schema**~~ — **done**, unblocked by node-firebird 2.14.2. See phase 3.

## Phase 2 status — the write path, mostly already done

Phase 2 as written ("qualified names on every write path") turns out to be largely satisfied by the read-path work, because qualification was pushed into the *names themselves* rather than bolted onto each SQL builder. Audited rather than assumed:

| Write path | Status |
| --- | --- |
| `SELECT *` (Select All Records) | qualified — `NodeTable`/`NodeView.getTableName()` |
| `DROP TABLE` / `DROP VIEW` / `DROP PROCEDURE` | qualified — same accessors |
| Script as Create | qualified, including each foreign key's two ends independently (phase 1e) |
| Row editing (`UPDATE`/`INSERT`/`DELETE`) | qualified — the results view receives the qualified name, and `assertValidIdentifier()` accepts two-part names (phase 1c) |
| Schema Designer / Table Designer DDL | qualified — the webview builds DDL from the graph's `name`, which is the qualified identity. Now pinned by two tests asserting `ALTER TABLE SALES.ORDERS …` and `ALTER TABLE PUBLIC.ORDERS …` rather than the bare forms |
| Drag identifier into editor | qualified — `getDragIdentifier()` returns the SQL name |
| **schema-diff** | done — snapshots are keyed by schema + name (see below) |
| **Database Projects** extract/publish | done — tables, views, procedures and triggers all qualified |

So what remains of phase 2 is exactly the two consumers already listed as outstanding, rather than a separate sweep. The remaining phases are 3 (search path), 4 (designer colour-coding), and 5 (schema lifecycle DDL).

## Phase 2a — schema-diff (done)

`fetchSchemaSnapshot()` keyed everything by bare name, so on Firebird 6 two same-named tables collapsed into a single snapshot entry whose columns were the union of both — and a diff against another database would then report phantom added and removed columns for a table that exists in neither. Verified live against the two-schema database:

```
tables in snapshot: PUBLIC.CAP_DEMO, PUBLIC.CUST, PUBLIC.ORDERS, PUBLIC.PW_DIAGRAM_DEMO,
                    PUBLIC.PW_PLAN_DEMO, SALES.CUST, SALES.ORDERS
  PUBLIC.ORDERS -> ID,NOTE,CUST_ID
  SALES.ORDERS  -> ID,TOTAL,CUST_ID
views: PUBLIC.ACTIVE, SALES.ACTIVE
```

Tables, views, procedures and triggers are all qualified now, so `diffSchemas()` compares like with like without any change to the comparison logic itself — the fix is entirely in what the snapshot is keyed by.

`fieldsQuery()` gained the same optional schema column. Its **name match deliberately stays name-only**: callers pass bare relation names and key the rows by schema + name themselves, which is simpler than threading qualified names through an `IN` list and produces the same result.

One consequence worth stating: a table that genuinely *moves* between schemas will read as a drop plus an add rather than a move, because the name is the identity. That is defensible — the two are different objects to every statement that references them — but it is a behaviour, not an oversight.

## Phase 2b — Database Projects (graph half done)

This was deferred twice on the grounds that qualified names change file names on disk and the doc prefers per-schema folders. The layout question turned out to be avoidable: the phase 1h split answers it. **File names use the display name, DDL content uses the qualified one.** Verified live:

```
table files: tables/CAP_DEMO.sql, tables/SALES.CUST.sql, tables/CUST.sql,
             tables/SALES.ORDERS.sql, tables/ORDERS.sql, ...
  tables/ORDERS.sql      -> CREATE TABLE PUBLIC.ORDERS (
  tables/SALES.CUST.sql  -> CREATE TABLE SALES.CUST (
```

A single-schema Firebird 6 database therefore keeps `tables/ORDERS.sql` rather than renaming every file in an existing project to `PUBLIC.ORDERS.sql`, while a second schema gets its own file instead of overwriting the first — which is what happened before, since both tables were one merged entry. The content is what has to be unambiguous, and it is.

Per-schema folders (`schemas/SALES/tables/…`) remain the tidier long-term layout, but they are now a refinement rather than a prerequisite for correctness.

**Now complete.** `getAllViewSourcesQuery()`, `getAllProcedureSourcesQuery()`, `getAllTriggerSourcesQuery()` and `getAllProcedureParametersQuery()` all gained the same optional schema column, and the snapshot qualifies each object. Verified live:

```
views     : PUBLIC.ACTIVE, SALES.ACTIVE
procedures: PUBLIC.TOTALS(M), SALES.TOTALS(N)
view files: views/ACTIVE.sql, views/SALES.ACTIVE.sql
proc files: procedures/TOTALS.sql, procedures/SALES.TOTALS.sql
```

The procedure line is the one to read twice: parameters are keyed by qualified name, so `PUBLIC.TOTALS` gets `M` and `SALES.TOTALS` gets `N`. Keyed by bare name — as before — each procedure collected *both* procedures' parameters, and the extracted DDL would have declared a signature that exists nowhere.

## Phase 4 — colour-coded schemas in the designer (done)

pgsql's presentation, and the thing that makes a multi-schema ER diagram readable: each schema's tables get a distinct header colour, with a legend saying which is which.

- **Colour by sorted position, not by hashing the name.** A hash can collide, and two schemas sharing a colour would be worse than no colour at all. Position spreads hues evenly around the wheel with fixed saturation and lightness chosen to stay legible against both light and dark editor themes.
- **Only when there is something to distinguish.** One schema means every box the same colour, which is noise, so both the colouring and the legend button stay hidden below two schemas — a pre-Firebird-6 database sees exactly what it saw before.
- **The legend is a toggle**, not a permanent panel: it floats over the canvas, so it has to be dismissable. It re-renders with the diagram rather than only on load, so adding a table from another schema lights it up without a refresh.

The data was already there — `buildSchemaGraph()` has carried `schema` per table since phase 1h — so this is presentation only, with `schemaColor()` and `schemasInDraft()` exported through the webview's existing `__test__` hook and covered by six tests.

## Phase 5 — schema lifecycle (create and drop done)

**Create Schema…** and **Drop Schema…**, on the database node's context menu and the Command Palette. Every statement was exercised against the live Firebird 6.0.0 server end to end — list, create, list again, drop, list again — rather than only unit-tested:

```
schemas (user): ["PUBLIC","SALES"]
schemas (all) : ["PUBLIC","SALES","SYSTEM"]
CREATE SCHEMA : ok      -> ["PUBLIC","SALES","TMP_PHASE5"]
DROP SCHEMA   : ok      -> ["PUBLIC","SALES"]
```

- **Version-checked first.** `RDB$SCHEMAS` and `CREATE SCHEMA` do not exist before Firebird 6, so both commands probe the engine version and say *"SQL schemas need Firebird 6 or newer; this server reports 5"* rather than surfacing a raw SQL error.
- **`SYSTEM` is not offered.** `getSchemasQuery()` hides it by default: it holds all `RDB$*`/`MON$*` metadata, is appended to every search path implicitly, and only index operations are permitted on it — listing it in a drop picker would invite an attempt that can only fail.
- **Drop does not cascade.** Firebird refuses to drop a schema that still contains objects, which is the behaviour worth keeping, so a mistaken drop cannot take a schema's tables with it. It still gets a modal confirmation, like every other drop here.
- **On the database node, not a Schemas node**, since there is no Schemas tree level yet — and reachable from the palette through the same `resolveDatabaseNode()` fallback the other tree-node commands now use.

**Alter Schema…** followed, covering both properties a schema has: its default SQL security and its default character set. The syntax had to be established against the live server rather than taken from the documentation, and it is **not** what `CREATE SCHEMA` uses:

```
ALTER SCHEMA SALES DEFAULT SQL SECURITY INVOKER      -> Token unknown - line 1, column 20 - DEFAULT
ALTER SCHEMA SALES SQL SECURITY INVOKER              -> SQL error code = -104
ALTER SCHEMA SALES SET DEFAULT SQL SECURITY INVOKER  -> accepted; RDB$SCHEMAS.RDB$SQL_SECURITY becomes <false>
ALTER SCHEMA SALES SET DEFAULT CHARACTER SET UTF8    -> accepted; RDB$CHARACTER_SET_NAME becomes UTF8
```

`CREATE SCHEMA` takes `DEFAULT …`; `ALTER SCHEMA` takes `SET DEFAULT …`. Guessing from the create syntax — which is what the design doc's own summary would have led to — produces a statement the server rejects.

Schema-level grants in the privileges viewer were left open here pending catalogue research; that research is done — see phase 6.

## Phase 3 — New Query in Schema (done); per-connection default schema (done)

**New Query in Schema…** — pgsql 1.21.0's own feature — opens an untitled SQL document already scoped to a schema you pick. What it does is worth showing rather than describing, verified live:

```
SET SEARCH_PATH TO SALES;
  session reports    -> "SALES", "SYSTEM"
  SELECT * FROM ORDERS -> {ID: 1, TOTAL: 999, CUST_ID: null}    <- SALES.ORDERS
```

Under the default path that same unqualified statement returns `{ID: 1, NOTE: "public-row"}` — `PUBLIC.ORDERS`. One line at the top of the document changes which table every unqualified name in it means.

**It seeds the statement rather than configuring the connection**, and that is the design decision here. The search path is *session* state, and this extension runs queries over a pooled connection whose session the user does not control — so setting it out of band would be invisible, would not survive the pool handing out a different connection, and would silently change what an unrelated editor's query means. In the document, what runs is what you can see, and it travels with the file if it is saved or shared.

`SYSTEM` is deliberately not named in the generated statement: Firebird appends it to every search path itself, so listing it would suggest the user controls something they do not.

**Completion is schema-aware now too.** The cache `db-words.provider.ts` builds is what powers completion, hover and Go to Definition, and it was still schema-blind: on a two-schema database it produced two identical `ORDERS` entries — indistinguishable in the list, and pooling each other's columns, since the column rows were keyed by bare name. It now asks for schemas (version-gated), keys columns by schema + name, and carries the schema on each `Schema.Table`.

`tableCompletionParts()` decides how each one is presented: the **label** is what a human reads (bare in the default schema, qualified elsewhere, so the two are distinguishable) while the **inserted text** is qualified whenever a schema is known, so accepting a completion never leaves the resulting SQL depending on the search path. `filterText` keeps the label as the filter, or typing `ord` would stop matching an entry whose insert text is `PUBLIC.ORDERS`.

It is a separate exported function precisely because driving the whole provider needs a faithful `TextDocument` — an attempt to test through `provideCompletionItems()` failed on the mock rather than on the logic, so the decision was extracted to where it can be tested directly.

**The per-connection default schema is now done**, unblocked by node-firebird 2.14.2 exposing `isc_dpb_search_path`. **Set Default Schema…** on a database (or from the Command Palette) picks from the server's own schema list and stores it on the saved connection; every session opened for that connection then resolves unqualified names through it, before its first statement runs.

This is deliberately different from **New Query in Schema…**, which puts a `SET SEARCH_PATH` at the top of *one document*: this applies to the tree, completion and every command as well, so they cannot disagree with the editor about what `ORDERS` means.

Firebird has no default-schema attachment parameter — `CURRENT_SCHEMA` is simply the first existing entry of the search path — so the driver implements it by putting the schema at the front, keeping `PUBLIC` behind it as a fallback while the server appends `SYSTEM`. Verified against the live 6.0.0 server through the extension's own `Driver`, using a probe table that exists in **one** schema only, since a table present in both would resolve either way and prove nothing:

```
with defaultSchema     SELECT ID FROM SP_PROBE -> 7
without it             SELECT ID FROM SP_PROBE -> -204 Table unknown
SEARCH_PATH            "DRIVER_SP_TEST", "PUBLIC", "SYSTEM"
```

**The pooling question this doc flagged was real, and it is the interesting part of the change.** `PooledClient` keyed its idle buckets on the connection id alone. The search path is a property of the *attachment*, not of the saved definition, so changing a connection's schema would have handed back an idle session still attached with the old one — unqualified names quietly resolving in the previous schema until the idle sweeper happened to evict it, which is the kind of bug that looks like the server misbehaving. The key now includes the schema, so a change starts a new bucket and the stale one ages out on its own. Three tests cover it, including that pooling still *works* when the schema is unchanged — a fix that disabled pooling would also have passed the first test.

**No version probe before attaching.** node-firebird sends the parameter only when the negotiated protocol is 20+, so setting it against a Firebird 5 server is inert rather than an error. The *UI* does check, and refuses to offer the picker on a pre-6 server rather than storing a setting that would silently do nothing.

**The native driver has no equivalent attach option** — `node-firebird-driver`'s `ConnectOptions` has no schema field at all, which is [asfernandes/node-firebird-drivers#172](https://github.com/asfernandes/node-firebird-drivers/issues/172) upstream. Rather than let the setting silently do nothing there, `NativeClient` issues `SET SEARCH_PATH` as the session's first statement, which reaches the same end state for one extra round trip. A pre-6 server rejects that statement, and the failure is logged rather than raised: the pure-JS driver ignores the same setting on such a server, and the two drivers should not disagree about whether a connection can be opened at all.

A workspace can declare it too — `"defaultSchema"` in `.vscode/firebird.json`, with the JSON schema updated so the editor completes it. Which schema a project's unqualified names mean belongs beside the database path in version control rather than in each contributor's own settings.

**Still open in this phase: search-path-aware completion ranking.** Completion distinguishes same-named tables and inserts qualified names, but does not yet rank a table in the search path above one that is not.

## Phase 1j — the Schemas tree level (done)

The Object Explorer nests *database → schema → categories* when a database has **more than one user schema**, and keeps the flat layout otherwise. Every Firebird 6 database has `PUBLIC`, so showing the level unconditionally would add a click for the overwhelming majority of databases, which have exactly one schema and always will.

`NodeSchema` owns no fetching: it hands each category the same child factory `NodeDatabase` would have used, pre-bound to its schema, so there is one implementation of "list the tables" rather than a schema-scoped copy of each. Scoping is a client-side filter on `SCHEMA_NAME`, which every listing query already returns — no second query shape. Objects inside a schema node lose their prefix (`ORDERS`, not `SALES.ORDERS` under a `SALES` node) via a `labelSchema` passed to each node type.

**Roles and Users stay database-wide** and appear only in the flat layout: `RDB$ROLES` has no schema column, so repeating them under every schema would imply an ownership that does not exist.

### Two problems only the extension-host suite could find

**`PLG$PROFILER` is a user schema as far as Firebird is concerned.** Firebird's own profiler creates it the first time the Live Profiler runs — a feature this extension offers — so an ordinary single-schema database would silently grow a schema level containing plugin internals, and offer `PLG$PROFILER` as something to drop. `getSchemasQuery()` now excludes `PLG$`-prefixed schemas, Firebird's own convention for plugin-owned objects. There was no way to predict this from reading code; the suite's profiler tests had created the schema, and the tree tests then failed.

**Database Projects and schema-diff had drifted to different naming conventions.** Publish emitted `CREATE OR ALTER PROCEDURE PUBLIC.PUB_PROC` while comparing against a snapshot that said `PUB_PROC`, so on a single-schema Firebird 6 database *every object looked rewritten*. The two suite-tier publish tests caught it (`PUB_PARENT should exist in the target snapshot`), and bisecting against `5ffc699` confirmed it arrived with the Database Projects schema work rather than the tree.

The fix is one convention throughout a project: **display-form identity** — bare in the default schema, qualified elsewhere — for file names, for diffing, and in generated DDL. A display name is still qualified for any schema other than the default, so nothing becomes ambiguous, and a single-schema database produces byte-identical output to before schemas existed.

## Phase 6 — schema-level grants (done)

**Show Object Privileges** now works on a schema node, and the answer to the research this was blocked on is two catalogue facts that are not written down anywhere:

- A `GRANT USAGE ON SCHEMA` is recorded in `RDB$USER_PRIVILEGES` like any other grant, under **`RDB$OBJECT_TYPE = 38`** with privilege code **`G`**.
- Such a row leaves **`RDB$RELATION_SCHEMA_NAME` null** — the schema *is* the object, it is not in one.

38 has to be hardcoded, because the catalogue cannot supply it: `RDB$TYPES` documents `RDB$OBJECT_TYPE` values 0–19 and 37 on Firebird 6.0.0 and simply stops, so 38 appears in privilege rows without ever being named. The earlier note in phase 2 — that a database which had a schema created and dropped showed no rows naming it — was true and misleading: the rows exist while the schema does.

**Filtering by object type is not a nicety.** A schema and a table may share a name, and `RDB$RELATION_NAME` holds both. On a live 6.0.0 database with a `SALES` schema and a `PUBLIC.SALES` table, asking for "the grants on SALES" without the type filter returns nine rows — `SELECT`, `INSERT`, `DELETE` and the rest of the table's grants mixed in with the schema's two `USAGE` rows. With it, two.

### A bug schemas had already introduced elsewhere

The same query backs the table, view and procedure nodes, and it matched on name alone. On Firebird 6 that silently merges: the live multi-schema database has an `ORDERS` table in *both* `PUBLIC` and `SALES`, each with five grants, so **Show Object Privileges on either one listed all ten** — one table appearing to hold contradictory permissions. Those three callers now pass their schema, and the query adds `RDB$RELATION_SCHEMA_NAME` only when given one, because that column does not exist before Firebird 6 and naming it unconditionally would make the statement fail to *prepare* rather than return nothing.

Four privilege codes were also being displayed as bare letters: `G` (USAGE, Firebird 4+ on generators and exceptions, and now schemas) and `C`/`L`/`O` (the DDL privileges behind `GRANT CREATE TABLE TO …`). All four occur in an ordinary database's catalogue — the live database has 375 `G` rows on generators alone.

Covered at three levels, because each catches something the others cannot: the SQL shape in unit tests, the **manifest** entry (a `showPrivileges()` method with no `view/item/context` contribution is dead code that nothing else would notice), and the two catalogue facts above as extension-host tests against a real 6.0.0 server — if a later Firebird renumbers object type 38, that suite says so instead of the viewer quietly coming back empty.

## Suggested phases

1. **Read path**: cache the engine major version per connection (reusing `parseEngineMajorVersion()`), add the schema-aware query variants behind that gate, and surface the Schemas level in the tree. No write-path changes — the tree stops lying first. — **done**: version cache, schema-aware listings for every object category, schema-filtered column metadata, qualified labels/SQL, and the Schemas tree level (phases 1a–1j).
2. ~~**Write path**: two-part qualified identifiers threaded through `ddl-builders.ts`, `row-edit.ts`, `selectAllRecordsQuery()`, and the designers' DDL generation.~~ — **done**, and largely satisfied by the read path rather than separately: qualification lives in the names themselves. Audited table by table in "Phase 2 status" above.
3. **Search path**: ~~"New Query in Schema"~~ and ~~the per-connection default schema~~ — both **done**; the second was unblocked by node-firebird 2.14.2 exposing `isc_dpb_search_path`. Search-path-aware completion *ranking* remains.
4. ~~**Presentation and tooling**: color-coded schemas plus legend in the Schema Designer; schema names in `get_schema` for the MCP/LM tools.~~ — **done** (phases 1g and 4).
5. **Lifecycle**: ~~`CREATE`/`DROP SCHEMA` actions~~ — **done** (phase 5); ~~`ALTER SCHEMA`~~ — **done**; ~~schema-level grants~~ — **done** (phase 6). Per-schema project folders remain; schema-qualified schema-diff is done (phase 2a).

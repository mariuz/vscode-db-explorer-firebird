# Data API Builder for Firebird

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql)'s Data API builder integration ("Create REST, GraphQL, and MCP endpoints for SQL databases", plus a Copilot-assisted config generator).

## Current state in Firebird Studio

**Phases 2 and 3 (Option A) are done**, despite this item's "speculative — validate demand first" flag (explicitly overridden — see Phase 1 below). Right-click a database → **Generate Data API Spec...** produces an OpenAPI 3.0 document (one CRUD route set per table) and opens it as plain JSON for review; **Generate Data API Spec with Copilot...** does the same but scoped by a plain-English description of what to expose.

- `src/data-api-builder/openapi-spec.ts` (`buildOpenApiSpec()`) — a pure function (no vscode/Driver dependency, unit-tested like `schema-graph.ts`) that turns a `SchemaGraph` (the same model the Schema Designer/schema-diff already assemble from `getSchemaColumnsQuery()`) into an OpenAPI document: a component schema per table (JSON Schema types mapped from Firebird's own `RDB$FIELD_TYPE` names), a list+create (`GET`/`POST /table`) path per table, and a get/update/delete-by-primary-key path (`GET`/`PUT`/`DELETE /table/{pk...}`) per table that has one — composite keys get one path segment per PK column. Tables with no primary key only get the list+create routes. An optional `tableAccess` option (phase 3, below) both scopes which tables are included at all and whether each gets full CRUD or GET-only routes; omitting it (the plain command's behavior) includes every table with full CRUD, unchanged from phase 2.
- `src/data-api-builder/index.ts` (`runDataApiSpecGenerator()`) — fetches the schema via the same `getSchemaColumnsQuery()` + `getForeignKeysQuery()` combined `Driver.runBatch()` call the Schema Designer uses, builds the spec, and opens it via `workspace.openTextDocument()` — plain, inspectable JSON, never executed or sent anywhere by the extension itself, per the design doc's explicit direction.
- **JSON, not YAML**: OpenAPI supports both equally; JSON avoids adding a YAML-serialization dependency (none is vendored in this extension today), consistent with this repo's stated preference.
- Wired to `firebird.database.generateDataApiSpec` (same command/menu-registration pattern as the other database-node actions) → `NodeDatabase.generateDataApiSpec()`.

The pre-existing state this replaces: none — this was a net-new capability, not an extension of an existing module. Microsoft's vscode-mssql version wraps their standalone [Data API builder](https://github.com/Azure/data-api-builder) tool (a .NET config-driven REST/GraphQL/MCP server) with a VS Code UI for authoring its config; there's no Firebird equivalent tool to wrap, which is exactly why Option A (spec generation only, no bundled server) was chosen.

### Phase 3 — Copilot-assisted natural-language config generation

- New `runDataApiSpecGeneratorWithCopilot()` (`src/data-api-builder/index.ts`), wired to **Generate Data API Spec with Copilot...** (`firebird.database.generateDataApiSpecWithCopilot`). Prompts for a plain-English description ("expose customers and orders as read-only"), then follows the same "small structured JSON decision, deterministic code applies it" split the Schema Designer's "Ask Copilot" panel already established for exactly this reason — the model is asked for `{"tables": {"TABLE_NAME": "full" | "read-only"}}` (`copilotScopingPrompt()`), never a raw OpenAPI document, so it doesn't need to get OpenAPI JSON syntax right; `buildOpenApiSpec()` (already proven by the phase-2 generator) turns that decision into the actual spec.
- `parseTableAccessResponse()` validates the model's answer against the schema's *real* table list (case-insensitively) before trusting it — a hallucinated or misspelled table name is silently dropped rather than producing a spec with a dangling `$ref`, the same "trust existence over the model's self-reported claim" rule `applyCopilotEdit()` already uses for the Schema Designer's Copilot edits (`docs/roadmap/visual-schema-designer.md`).
- `extractJson()` (stripping an optional ` ```json ` fence from a model response) was pulled out of `schema-designer/index.ts` into a new shared `src/copilot/json-extraction.ts`, now used by both features rather than kept as two independently-drifting private copies.
- **Verified against a real Firebird 6.0 server** (`/opt/firebird`): fetched a real schema (3 tables, one real foreign key) through the actual `getSchemaColumnsQuery()`/`getForeignKeysQuery()`/`buildSchemaGraph()` path, then ran a plausible simulated model response — deliberately including a wrong-case table name and one hallucinated table name, to exercise the defensive path for real — through the real `parseTableAccessResponse()` and `buildOpenApiSpec()`. Confirmed the hallucinated table was dropped, casing was normalized to the schema's real names, the excluded table got no paths or schema at all, and the read-only table correctly lost its `POST`/`PUT`/`DELETE` operations while keeping `GET`. The actual Copilot/language-model call itself isn't exercisable from a headless script (it needs an interactive, signed-in Copilot Chat session) — that half is unverified live, consistent with how the Schema Designer's own "Ask Copilot" panel was accepted without a live-server LLM call either, only structural/unit coverage of the deterministic parts around it.

**Suite-tier coverage** (`src/test/suite/data-api-builder-integration.test.ts`, new): drives the real `runDataApiSpecGenerator()` inside a real Extension Development Host against a real Firebird server — confirms the opened document is real JSON (`openapi: "3.0.3"`), its `/products` path and `PRODUCTS` component schema reflect the live table's real columns, and a full-access table gets both `GET` and `POST`. Previously this module (as opposed to `buildOpenApiSpec()`'s pure logic, already unit-tested) had no suite-tier coverage against a live server; only the phase-3 Copilot-scoping path above had been checked that way.

### Phase 5 — column-level include/exclude (not done)

**Added after the fact from a [vscode-mssql](https://github.com/microsoft/vscode-mssql) 1.43.0 review** — "Added support for including and excluding columns to Data API builder". Today's `tableAccess` option scopes the spec at *table* granularity only (which tables appear, and whether each is full-CRUD or GET-only); every column of an included table is exposed. That's the wrong granularity for the case this feature most obviously serves — exposing a table that has a `PASSWORD_HASH`, `SALARY`, or internal audit column you don't want in a public REST surface.

The natural shape, given what already exists: extend the `tableAccess` entry from a bare `"full" | "read-only"` string to an object that can also carry `includeColumns`/`excludeColumns`, and filter inside `buildOpenApiSpec()` where it already walks `table.columns`. Two constraints worth settling up front — a primary-key column can't be excluded without also dropping that table's by-PK routes (the path template needs it), and an excluded `NOT NULL` column with no default makes the generated `POST` body unsatisfiable, so the generator should either refuse or downgrade the table to read-only rather than emit a spec that can't work. The Copilot path (phase 3) then needs nothing new structurally: `copilotScopingPrompt()` asks for a richer JSON shape and `parseTableAccessResponse()` validates column names against the real schema exactly as it already validates table names.

### Explicitly deferred (not done)

- **Phase 4 — Option B (bundled server runtime)**: no scaffolded Node/Express/GraphQL project — this remains "generate a spec for your own backend," not "run a Firebird API server," per the design doc's recommendation not to start Option B casually.
- Foreign keys are fetched (reused from the Schema Designer's query) but not yet reflected in the generated spec (e.g. as OpenAPI relationship/links or nested-resource routes) — the FK rows are currently discarded after building the graph.

## Proposed feature

Given there's no existing "Data API builder for Firebird" server to integrate with, this feature has two viable shapes — worth deciding explicitly before building either:

**Option A — config generator only.** The extension inspects the connected schema (same metadata the tree provider and schema-diff already read) and generates a config file for an existing generic API-generation tool the user runs themselves (e.g. PostgREST-style tools don't support Firebird directly, but a hand-rolled minimal REST layer could). This keeps the extension's scope to "generate config," matching mssql's actual division of labor (VS Code extension authors config; a separate service executes it).

**Option B — bundled lightweight server.** The extension scaffolds and can launch a small Node/Express (or Fastify) REST API project that uses the same `node-firebird`/native driver already vendored in this extension, with one CRUD route set per table/view generated from schema metadata, plus a minimal GraphQL layer (e.g. via `graphql` + a resolver generated per table). This is a much bigger undertaking — effectively shipping and maintaining a second, standalone piece of software — and should not be started casually.

Given the effort gap, **recommend starting with Option A**, scoped down further to: generate an OpenAPI/REST route spec (paths, request/response shapes per table's columns and PK) as a reviewable artifact the user can hand to their own backend, without the extension running a server itself. Revisit Option B only if there's clear user demand for a bundled runtime.

## Copilot integration

Whichever option is chosen, a natural Copilot hook (mirroring "GitHub Copilot in Data API builder") is a slash command or button that takes a natural-language description ("expose customers and orders as read-only, orders filterable by customer_id") and the current schema context (`schema-context.ts`'s existing serialization) and produces the generated config/spec — same `request.model.sendRequest()` pattern as the rest of `src/copilot/`.

## Technical notes

- This is the least-grounded item on this list relative to the existing codebase — no current module to extend, and the underlying tool-to-wrap doesn't exist for Firebird the way it does for SQL Server. Treat the estimate here as rougher than the others, and validate demand before investing.
- If pursued, keep the generated artifact (config/spec file) as plain, inspectable text opened via `Driver.createSQLTextDocument()`-style `workspace.openTextDocument()`, not something silently executed — consistent with this extension's existing pattern of always showing generated SQL/DDL for review before running it.

## Suggested phases

1. ~~Validate scope/demand (this is speculative enough that it may not be worth building without concrete user requests).~~ — explicitly overridden: asked directly whether to build this or skip to the next roadmap item, given the speculative flag; the answer was to build it anyway.
2. ~~REST route-spec generator (Option A) from schema metadata, no server.~~ — **done**.
3. ~~Copilot-assisted natural-language config generation.~~ — **done**.
4. (Only if justified) bundled minimal server runtime (Option B).
5. Column-level include/exclude in `tableAccess`/`buildOpenApiSpec()`, plus the matching richer Copilot scoping response — see phase 5 above for the primary-key and `NOT NULL` constraints that need deciding first.

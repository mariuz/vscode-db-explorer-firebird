# SQL language features beyond completion (definition, hover, outline)

**Inspired by**: [vscode-mssql](https://github.com/microsoft/vscode-mssql), which lists "Restored Go-to-Definition functionality on macOS and Linux for SQL Database Projects" as a 1.44.0 fix — i.e. Go to Definition on a SQL object name is a feature mssql considers table stakes — and [vscode-pgsql](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql), whose object explorer generates `SELECT`/`CREATE`/`ALTER`/`DROP`/`EXECUTE` scripts for any object and whose IntelliSense covers "table names, column names, functions, schemas, keywords, and join clauses".

## Current state in Firebird Studio

**One provider, and only one.** `grep -rn 'languages.register' src/` returns exactly one hit:

```
src/language-server/index.ts:25: languages.registerCompletionItemProvider(documentSelector, this.completionProvider, "*", ".")
```

That is the whole language-feature surface for `.sql` files. There is no `DefinitionProvider`, `HoverProvider`, `DocumentSymbolProvider`, `DocumentLinkProvider`, `CodeLensProvider`, `RenameProvider`, or `ReferenceProvider` anywhere in the codebase — despite `src/language-server/` being named as if it were an LSP (it is not; it is a plain in-process completion provider, and nothing in the repo depends on `vscode-languageclient`/`vscode-languageserver`).

What *does* exist and would be reused rather than rebuilt:

- **`SchemaProvider`** (`src/language-server/db-words.provider.ts`), already injected into `CompletionProvider` and already caching the connected database's tables and columns — the same index a definition/hover provider needs.
- **`extractTableNames()`** (`src/shared/driver.ts`, used by the `EXPLAIN PLAN` fallback) and the linter's own parsing in `src/shared/sql-linter.ts` — existing, unit-tested identifier extraction, so "which object name is under the cursor" does not start from zero.
- **`sql-splitter.ts`**, which already finds statement boundaries in a multi-statement document — that is the hard half of a document outline.
- **`src/script-as/ddl-builders.ts`** plus `getViewDefinitionQuery()`/`createViewScaffold()` and friends in `queries.ts` — the DDL text a "go to definition" would show already exists and is already produced for the tree's Script as Create action.
- **`firebird.linting.validateTableNames`**, an existing setting that already resolves identifiers against live schema metadata — so the "is this name real?" lookup is proven, including its failure modes when no connection is active.

## Proposed feature

Three providers, in increasing order of cost, all guarded on there being an active connection (each degrades to "no result", never to an error dialog — the linter's `validateTableNames` already establishes that convention):

- **Go to Definition (`registerDefinitionProvider`)** — `F12` on a table, view, procedure, trigger, generator, or domain name opens its DDL. Firebird has no source file to jump to, so the target is a generated document: reuse `ddl-builders.ts` to script the object into an untitled read-only `.sql` document, which is exactly what the tree's Script as Create action already produces. Two consequences worth deciding up front: (a) the definition has no stable `Uri`, so repeated `F12` on the same object should reuse one document rather than opening N copies, and (b) with [Firebird 6 schemas](firebird6-schemas.md) an unqualified name can resolve to several objects — `DefinitionProvider` can return an array, and VS Code renders that as a picker, which is the right answer rather than guessing.
- **Hover (`registerHoverProvider`)** — hovering a table name shows its columns with types/nullability; a column shows its type, domain, and default; a procedure shows its parameter list. All of it comes from queries `queries.ts` already has (`fieldsQuery()`, `procedureParametersQuery()`, `getDomainsQuery()`). This is the highest value-per-line item here: the same metadata that completion already fetches, surfaced where you are reading rather than only where you are typing. Note `MarkdownString` in tree labels is still a *proposed* API (see [vscode-api-adoption.md](vscode-api-adoption.md)), but `MarkdownString` in a **hover** has been stable for years — no proposal risk.
- **Document Symbols (`registerDocumentSymbolProvider`)** — populates the editor breadcrumb and the Outline view with one entry per statement in a `.sql` file, labelled by statement kind and target object (`CREATE TABLE CUSTOMERS`, `INSERT INTO ORDERS`, …). `sql-splitter.ts` already yields the offsets; this is mostly a mapping from statement text to a label, and it makes long migration scripts navigable. It also composes with `firebird.runCurrentStatement`, which already resolves the statement under the cursor.

**Deliberately not proposed**: a real LSP server process. VS Code 1.125 shipped `vscode-languageclient`/`vscode-languageserver` 10.0.0 with LSP 3.18, but a separate process buys nothing here — the providers need `Driver`/`Global.activeConnection`, which live in the extension host, and every provider above is a metadata lookup rather than a parse-heavy analysis. Rename/find-all-references are also out of scope: renaming a Firebird object is a DDL operation with dependency implications, not a text edit, and pretending otherwise in an editor gesture would be actively dangerous.

## Phase 1 — hover (done)

`languages.registerHoverProvider` is now the *second* language provider in this extension. Hovering an identifier in a `.sql` file shows what the connected database knows about it:

- a **table** — its columns and their types, as a markdown table;
- a **column** — its type and which table it belongs to, listing *all* of them when several tables share the name, since picking one arbitrarily would be actively misleading;
- **anything else** — no hover at all. A keyword or an alias must not get an invented "unknown object" popup.

It costs no new queries: the provider shares the completion provider's schema handler, so it reads the same cache. Matching is case-insensitive because unquoted Firebird identifiers fold to upper case, and `$` counts as an identifier character — without that, every `RDB$`/`MON$` system object would fail to resolve.

Split so the logic is testable: `hover-model.ts` holds `identifierAt()` and `buildHoverMarkdown()` (both pure, 12 tests), and `hoverProvider.ts` is the VS Code adapter, which also swallows a schema-lookup failure rather than letting it surface — a hover that throws becomes an error notification on mouse-move, which is worse than no hover.

**A test of mine was wrong, not the code.** `identifierAt` treats a cursor immediately *after* a word as belonging to it — positions sit between characters, which is the same rule VS Code's own `getWordRangeAtPosition()` applies. My first test asserted the opposite for the space after `SELECT`; it was corrected, and the rule now has an explicit test naming the reason.

**Not verified end to end.** Two attempts at a Playwright spec failed — a DOM-level mouse hover cannot reliably target an identifier because Monaco splits a line into syntax-coloured spans, and driving the editor's own `Show or Focus Hover` command did not produce a `.monaco-hover` element within the timeout either. Both attempts also destabilised the tab-icon spec sharing that VS Code instance, so neither was kept. What is covered is the markdown and the identifier extraction; what is not is that the provider is registered correctly and that VS Code renders its output.

## Suggested phases

1. ~~**Hover** — the cheapest and most-used of the three, and it validates the "identifier under the cursor" resolution logic that the other two depend on.~~ — **done**, see above. `identifierAt()` is now available for phases 2 and 3 to reuse.
2. **Document Symbols** — pure text analysis over `sql-splitter.ts`, no connection required, so it works in a file with no active connection.
3. **Go to Definition** — reuses phase 1's identifier resolution plus `ddl-builders.ts`, and needs the generated-document lifecycle question answered first.

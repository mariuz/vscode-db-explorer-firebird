# VS Code platform API adoption (1.102 → 1.131)

**Why this doc exists**: `package.json` declares `"engines": { "vscode": "^1.101.0" }` with `@types/vscode` pinned to `~1.101.0`. VS Code stable is **1.131** (released 29 July 2026). Nothing is broken by that — `^1.101.0` means "1.101 or newer", so the extension runs fine on 1.131 — but the type floor means **every API added since 1.101 is invisible to this codebase**, including several that map directly onto code already written here by hand. This is a review of the 30 intervening releases' extension-authoring sections, filtered to what this extension could actually use.

A note on cadence, because it changes how to read version numbers: 1.102 shipped in June 2025 and 1.131 in July 2026, so the gap is roughly 13 months, not 30. VS Code moved to a sub-monthly release cadence during 2026 (1.108 was December 2025 — 23 releases in the following ~7 months). Pinning `engines.vscode` a few minor versions back now costs far less calendar time than it used to.

**The hard constraint on everything below**: an extension published to the Marketplace can only use **finalized** APIs. Proposed APIs require `enabledApiProposals` plus `--enable-proposed-api` and are Insiders/development-only; VS Code refuses to publish an extension that declares them. So the two lists below are genuinely different in kind — one is work that can be scheduled, the other is a watch list.

## Finalized — adoptable today

| API | Since | Where it applies here |
| --- | --- | --- |
| `context.secrets.keys()` | 1.105 | `CredentialStore` (`src/shared/credential-store.ts`) |
| `secondarySidebar` view container location | 1.106 | `contributes.viewsContainers` |
| `QuickPick.prompt`, `QuickPickItem.resourceUri` | 1.108 | connection wizard, object search |
| `QuickInputButton.location` (`Title`/`Inline`/`Input`), `QuickInputButton.toggle` | 1.109 | connection picker, Object Explorer filter |
| `chatPromptFiles` / `chatInstructions` contribution points | 1.105 | `src/copilot/prompts.ts` |
| `chatSkills` contribution point | 1.109 | same — verify finalized status before scheduling |
| `ThemeIcon` as a webview/custom-editor tab icon | 1.110 | all six webviews |
| `onTerminal` / `onTerminalShellIntegration` activation events | 1.103 | `src/shared/isql-terminal.ts` |
| `env.isAppPortable` | 1.110 | native-driver build path |
| `vscode-languageclient`/`-server` 10.0.0 (LSP 3.18) | 1.125 | not applicable — see below |

### The three worth doing

**1. `secrets.keys()` closes a real credential leak.** `CredentialStore` stores under two prefixes (`firebird.password.<id>`, `firebird.sshPassword.<id>`) and exposes `store`/`get`/`delete` per connection — but **nothing can enumerate them**. A secret is only ever removed if the delete path runs; a connection removed while its delete failed, a `globalState` entry lost, or an id that changed shape across versions leaves a password in SecretStorage permanently, with no way for the user or the extension to see it, let alone clear it. `keys()` makes two things possible that are impossible today: a reconciliation pass at activation that drops secrets whose connection id is no longer in `Constants.ConectionsKey`, and a **Firebird: Clear All Saved Passwords** command that can honestly claim to have cleared everything. Given that "passwords never touch `globalState`" is a documented guarantee of this extension, being unable to audit the store that *does* hold them is the gap worth closing first.

**2. Ship Firebird dialect knowledge as `chatInstructions`, not just a chat participant.** `src/copilot/prompts.ts` already encodes what a model needs to write correct Firebird SQL (`FIRST`/`SKIP` rather than `TOP`/`LIMIT`, `EXECUTE BLOCK`, generators/sequences rather than `SERIAL`, PSQL block structure) — but that knowledge only reaches the model when the user goes through `@firebird`. Agent mode, inline chat, and any other model in the picker get none of it, even though this extension already registers five `languageModelTools` those same agents *can* call. A `contributes.chatInstructions` file (1.105) applies the dialect rules to any chat in the workspace, which is the missing half of the LM-tools work: the agent can already query the database, but nothing tells it that the SQL it writes is Firebird. This is close to free — the text exists; it needs a file and a contribution entry.

**3. `ThemeIcon` webview tab icons.** Six webviews (`result-view`, `query-plan-view`, `profiler`, `schema-designer`, `data-api-builder`, `sql-notebook`'s renderer host) currently open with the generic editor tab icon, so a window with several of them open is unreadable at the tab strip. 1.110 allows a `ThemeIcon`, i.e. a codicon that follows the theme, instead of shipping light/dark PNG pairs.

### The rest, briefly

- **QuickInput toggles/`prompt`/`resourceUri`** are a fit for `src/shared/object-explorer-filter.ts` and `src/object-search/` — a persistent `prompt` line explaining the filter syntax, and an inline **toggle** for "include system objects" (today `firebird.showSystemObjects` is a settings-level flag, not something you can flip mid-search).
- **`secondarySidebar`** would let the Firebird tree sit opposite the editor while results occupy the panel — a layout users currently cannot get, since the container is activity-bar-only.
- **`onTerminalShellIntegration`** is a refinement, not a fix: `isql-terminal.ts` already handles shell integration being absent (0.1.96/0.1.97), so this only sharpens activation timing.
- **LSP 3.18 / languageclient 10 is explicitly not applicable** — see [sql-language-features.md](sql-language-features.md) for why a separate language-server process buys this extension nothing.
- **Not applicable at all**, recorded so the next review does not re-derive it: the Language Model *Chat Provider* API (1.104 — this extension consumes models, it does not provide them), authentication `WWW-Authenticate` challenges and `AuthenticationSession.idToken` (1.104/1.106 — no OAuth provider here; Firebird auth is SRP over the wire protocol), `getRepositoryWorkspace` (1.106, Git), and the TypeScript-extension-authoring-without-a-build-step experiment (1.108 — this repo bundles with esbuild deliberately).

## Proposed — watch, do not schedule

Each of these lines up with something this codebase does by hand, which is exactly why they are worth tracking; none can ship to the Marketplace until finalized.

- **`approveCombination` on `LanguageModelToolConfirmationMessages`** (1.114) — fine-grained tool approval scoped to specific argument combinations. `run_write_query` (`src/shared/db-tools.ts`) is today gated by one opt-in setting plus a blanket `prepareInvocation()` confirmation; per-combination approval is the difference between "approve every write forever" and "approve writes to this table". The most consequential item on this list for a database extension.
- **`workspace.getTextDiff()`** (`documentDiff`, 1.120) — exposes VS Code's own diff algorithm, including a streaming async iterable. `src/schema-diff/` currently renders a hand-built text report; this would let it produce a real diff without vendoring a diff library.
- **`customEditorDiffs` / `diffEditorPriority` / `mergeEditorPriority`** (1.120) and **`customEditorPriority`** (1.129) — a custom editor can render its own diff UI. The natural target is Database Projects' publish preview and schema-diff, where a side-by-side schema comparison in a real diff editor beats a report.
- **`chatContextProvider`** (1.107) — contribute domain context to chat. `src/copilot/schema-context.ts` already serializes the connected schema into the `@firebird` system prompt; this is the API that would make the same context available to *any* chat session, and it pairs with the `chatInstructions` item above.
- **Chat output renderer (`ChatOutputWebview`)** (1.103, revised 1.109) — render a custom webview inside a chat response. The results grid in `src/result-view/` is the obvious payload: an agent that runs a query could show the actual grid rather than a markdown table.
- **`MarkdownString` in `TreeItem` labels** (1.106) — codicons and formatting in Object Explorer labels, where type/constraint annotations are currently plain text.
- **`extensions.supportAgentsWindow`** (1.120) — a setting by which extensions opt into the Agents window. Worth watching now that the Agents window is where multi-agent work happens; whether a database extension belongs there is an open question, not a given.

## Phases 1–2 — the engine floor and `secrets.keys()` (done)

`engines.vscode` and `@types/vscode` are now `^1.110.0` / `~1.110.0`, the floor that covers every finalized API on the adoptable list above. That is the only reason to raise it this far in one step — `secrets.keys()` alone needs just 1.105 — but the remaining items (`ThemeIcon` webview tab icons at 1.110, the QuickInput refinements at 1.108/1.109) are all planned, and moving the floor once is less disruptive than three times.

**The credential leak is closed.** `CredentialStore` could store, read and delete a password per connection but not *enumerate* them, so a secret orphaned by a failed delete or a lost `globalState` entry stayed in SecretStorage permanently — invisible to the user and to the extension alike. Two additions:

- **`listStoredConnectionIds()`** returns the database and SSH connection ids that currently have secrets, stripped of their key prefixes and ignoring keys belonging to anything else.
- **`deleteOrphans(liveConnectionIds)`** removes every secret whose connection is not in the given set, and returns how many went. It takes the live ids rather than reading `globalState` itself, so the caller owns the definition of "still exists" and the function stays testable without a workspace.

Both are used twice over. Activation reconciles against the saved connections — deliberately not awaited, since it is housekeeping and activation should not wait on it — and a new **Firebird: Clear All Stored Passwords** command passes an *empty* live set, which is the same operation meaning "nothing is live". The command confirms modally first and reports the count, and says so plainly when there is nothing to clear rather than silently doing nothing.

Six unit tests cover it, including the cases that are easy to get wrong: an SSH secret surviving when its connection is live but has no database password, and keys from other extensions being left alone. The `vscode` mock gained `secrets.keys()`.

## Phase 3 — Firebird dialect rules as `chatInstructions` (done)

`instructions/firebird-sql.instructions.md`, contributed via `contributes.chatInstructions` (VS Code 1.105). Any chat in the workspace now gets the dialect rules, not just the `@firebird` participant — which is the missing half of the language-model tools work: an agent could already query the database, but nothing told it that the SQL it writes is Firebird.

**A correction to this doc's own claim.** It said `src/copilot/prompts.ts` "already encodes what a model needs to write correct Firebird SQL (`FIRST`/`SKIP` …, `EXECUTE BLOCK`, generators/sequences …)". It does not. The shared `systemPrompt()` says only *"Always use Firebird SQL dialect and syntax"* — the specifics live solely in the `/migrate` command's prompt, where they describe converting *from* other dialects. So this phase was writing the content, not moving it, and the instructions file is now the one place the dialect rules are actually spelled out.

What it covers, chosen as the differences that most often produce SQL Firebird rejects outright: `FIRST`/`SKIP` and `OFFSET`/`FETCH` instead of `LIMIT`/`TOP`; `RDB$DATABASE` as the dummy table; unquoted identifiers folding to upper case; identity columns and sequences instead of `AUTO_INCREMENT`/`SERIAL`; `||` for concatenation and single quotes for strings; `EXECUTE BLOCK` and the `SET TERM` dance for scripts containing procedural code; `RDB$`/`MON$` instead of `information_schema`; and Firebird 6 schemas, including the advice to qualify names rather than trust the search path — the exact failure the schema work in this repo has been fixing all session.

**Scoped with a `when` clause** (`resourceExtname == .sql || resourceExtname == .fbnb`) rather than applied to every chat in the workspace. A database extension has no business injecting SQL dialect rules into a conversation about someone's TypeScript. The trade-off is that a chat started from a non-SQL file will not pick them up, which is the right side to err on.

The VSIX smoke test gained a case for it. Instructions ship as plain Markdown outside `out/` and `src/`, so a broad ignore rule is exactly what would drop them — and their absence is silent, since chat simply stops receiving the rules with no error anywhere. That test is now 11 assertions and passed against the real packaged extension.

## Phase 4a — themed webview tab icons (done)

All five webview panels now set a `ThemeIcon` tab icon: results `table`, Schema Designer `type-hierarchy`, query plan `graph`, profiler `pulse`, mock data `beaker`. Four of them share `QueryResultsView`, so the icon is a constructor parameter there and each subclass names its own; mock data creates its panel directly and sets it inline.

**Correction to this doc's own count**: it said *six* webviews. There are five panels. The SQL Notebook renderer is a notebook renderer, not a webview panel, and Data API Builder opens a text document rather than a webview at all.

A `ThemeIcon` needs no assets and follows the active theme, unlike the light/dark PNG pairs this extension ships for tree items — which is the point of the 1.110 API.

**Verified in a real VS Code**, not just type-checked: the Playwright tier now asserts `.tab .codicon-table` is visible after running a query. That is checkable there and essentially nowhere else — the unit tier's `vscode` mock would accept any string as a codicon id, so a typo would pass every other test and simply render nothing.

## Phase 4b — QuickInput refinements (done, one item found already satisfied)

**The Object Explorer filter already had its prompt.** This doc proposed "a persistent `prompt` line explaining the filter syntax" for it — `NodeCategoryFolder.setFilter()` has used `showInputBox` with exactly that prompt since it was written. Nothing to do; recorded so the next reader does not go looking.

**Object search got both.** It used `showQuickPick()`, which cannot express either feature, so it is now built with `createQuickPick()`:

- A **`prompt`** (1.108) under the input: *"Matches on name and type. Enter opens the object's primary action."* — the second half matters, because pressing Enter does not just close the picker, it runs a `SELECT`, opens an ALTER scaffold or peeks a generator value depending on what is selected.
- An **inline toggle** (1.109) for system tables. This is not a client-side filter: system objects are excluded in *SQL*, by an `RDB$SYSTEM_FLAG` predicate in every listing query, so turning it on runs one extra query and merges the results. Fetched once and remembered, so toggling repeatedly does not re-query.

**Scope worth stating plainly**: the toggle adds system *tables* — the only system category with an existing query. System triggers, procedures and domains are not included, so it is narrower than the "include system objects" the doc originally imagined.

**Not covered by an automated test**, and this is now the third feature in that position: `firebird.database.searchObjects` takes a `NodeDatabase`, so it cannot be invoked from the Command Palette and the Playwright tier cannot reach it either (the same limitation already recorded for `setPassword` and `schemaVisualizer.open`). What *is* testable was extracted into `search-model.ts` — `mergeSystemResults()` and `describeResult()`, with three tests covering the two things worth pinning down: that the merged list is one alphabetical sequence rather than two sorted blocks appended, and that system entries stay distinguishable.

That recurring gap is itself a finding. A palette-invocable variant of these node-argument commands, falling back to the existing `connection-picker.ts`, would make three features testable at once and is worth its own roadmap item.

## Suggested phases

1. ~~**Raise the floor**: `engines.vscode` and `@types/vscode` to `^1.110.0`.~~ — **done**.
2. ~~**`secrets.keys()`**: activation-time reconciliation plus a "Clear All Saved Passwords" command.~~ — **done**, see above.
3. ~~**`chatInstructions`** carrying the dialect rules, so agent mode writes Firebird SQL without going through `@firebird`.~~ — **done**; note the rules had to be written, not moved (see above).
4. ~~**Presentation**: `ThemeIcon` webview tab icons, then the QuickInput toggle/prompt refinements.~~ — **done** (phases 4a and 4b).
5. **Re-review** the proposed list — items graduate quickly at the current cadence, and `approveCombination` in particular changes how the write-query gate should be designed, so it is worth checking before that gate is reworked for any other reason.

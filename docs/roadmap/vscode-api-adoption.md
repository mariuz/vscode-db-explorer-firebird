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

## Suggested phases

1. **Raise the floor**: `engines.vscode` and `@types/vscode` to `^1.110.0` — the lowest version that covers every "adoptable today" item above. Do this alone, in its own change, and confirm the vscode-host suite still passes; everything else here depends on it.
2. **`secrets.keys()`**: activation-time reconciliation against saved connections plus a "Clear All Saved Passwords" command, with unit coverage in the existing `vscode` mock (`src/test/mocks/vscode.ts` needs a `secrets.keys()` stub).
3. **`chatInstructions`** carrying the dialect rules already in `prompts.ts`, so agent mode writes Firebird SQL without going through `@firebird`.
4. **Presentation**: `ThemeIcon` webview tab icons, then the QuickInput toggle/prompt refinements in object search and the Object Explorer filter.
5. **Re-review** the proposed list — items graduate quickly at the current cadence, and `approveCombination` in particular changes how the write-query gate should be designed, so it is worth checking before that gate is reworked for any other reason.

# Language Model Tools (Copilot agent mode without MCP)

**Inspired by**: VS Code 1.95's finalized extension API — "We have finalized our [`LanguageModelTool` API](https://code.visualstudio.com/api/references/vscode-api#lm.tools)! This API enables chat extensions to build more powerful experiences by connecting language models to external data sources, or take actions." Both [vscode-mssql](https://github.com/microsoft/vscode-mssql) (1.43.0) and [vscode-pgsql](https://github.com/microsoft/vscode-pgsql) (1.27.0) have since moved their Copilot integrations to GA, and agent-mode tool calling — not a mention-based chat participant — is the shape that integration has settled into.

## Current state in Firebird Studio

**Not started.** The extension already has three separate AI surfaces, and this is the one that's missing:

- **`@firebird` chat participant** (`src/copilot/`, `/query`, `/optimize`, `/explain`) — only reachable when the user explicitly types `@firebird`. Registered conditionally on `typeof vscode.chat !== 'undefined'`.
- **Direct model calls** via `vscode.lm.selectChatModels({ vendor: "copilot" })` in `src/schema-designer/index.ts`, `src/flat-file-import/index.ts`, `src/data-api-builder/index.ts`, and `src/copilot/ai-query-actions.ts` — the extension drives the model, not the reverse.
- **MCP server** (`src/mcp-server/`) exposing `list_connections`, `get_schema`, `run_query`, `get_query_plan` (read-only) and the opt-in `run_write_query`, registered through `vscode.lm.registerMcpServerDefinitionProvider` and gated behind the `firebird.mcpEnabled` setting. Note that `server.registerTool` in `src/mcp-server/server.ts` is the **MCP SDK's** method, not VS Code's.
- **`vscode.lm.registerTool` and `contributes.languageModelTools` are used nowhere** — confirmed by grep: no `languageModelTools` key in `package.json`'s `contributes` (which has `chatParticipants` and `mcpServerDefinitionProviders` but not this), and no `LanguageModelTool` anywhere under `src/`.

The practical consequence: in Copilot **agent mode**, Firebird is reachable only if the user has found and enabled `firebird.mcpEnabled` and has an MCP-capable client running. A `languageModelTools` contribution is offered to any agent request automatically, and to normal chat via a `#`-reference, with no MCP hop and no separate server process.

### Version constraint (needs deciding before phase 4)

`package.json` declares `engines.vscode: ^1.93.0`, so adopting this API requires raising the floor to `^1.95.0`. Worth fixing at the same time: `devDependencies["@types/vscode"]` is `^1.32.0`, which npm resolves to **1.125.0** — the compiler currently accepts APIs from 30+ releases beyond the declared engine floor, so nothing would have caught an accidental post-1.93 API use today either. The two should be pinned to the same minor.

## Proposed feature

- **One implementation, two transports.** The five MCP tool bodies in `src/mcp-server/server.ts` are already the exact operations a language model wants; the work is extracting them into a transport-agnostic module (taking a connection + arguments, returning structured data) that both the MCP server and a set of `LanguageModelTool` implementations call. Re-implementing them against `vscode.lm` while leaving the MCP copies in place would give two behaviors, two error shapes, and — critically — two write paths to keep in sync with one audit log.
- **`contributes.languageModelTools` entries** with `toolReferenceName`s (`#firebirdSchema`, `#firebirdQuery`, …) so they work as explicit `#`-references in ask mode as well as automatic agent-mode tools, plus `modelDescription` text that tells the model Firebird's dialect specifics (`FIRST`/`ROWS` instead of `LIMIT`, `RDB$` system tables) — the same context `src/copilot/schema-context.ts` already assembles for the chat participant.
- **Reuse the existing write gate for the write tool.** `run_write_query`'s opt-in setting and audit log already exist; the LM-tool version should sit behind the same gate rather than a parallel one, and additionally implement `prepareInvocation()` to return a confirmation message — that callback is exactly the API's affordance for "this tool mutates something, ask first", and agent mode will otherwise call it unattended.
- **Don't retire the MCP server.** It serves clients outside VS Code; this is an additional transport for the in-editor case, not a replacement.

## Suggested phases

1. Extract the five tool bodies out of `src/mcp-server/server.ts` into a transport-agnostic module — no behavior change, and it makes the tool logic unit-testable without an MCP client, which it isn't today.
2. The four read-only tools (`list_connections`, `get_schema`, `run_query`, `get_query_plan`) as `contributes.languageModelTools` + `vscode.lm.registerTool`, registered conditionally the same way the chat participant already guards on `typeof vscode.chat !== 'undefined'` so the vscode-host activation test stays independent of Copilot being installed.
3. `run_write_query` behind the existing opt-in setting *and* a `prepareInvocation()` confirmation.
4. Raise `engines.vscode` to `^1.95.0` and pin `@types/vscode` to match — needed for phase 2 to be legitimate, and worth doing regardless of the rest of this item.

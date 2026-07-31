# isql Terminal Shell Integration

**Inspired by**: VS Code 1.93's finalized extension API — "The terminal shell integration API is now available to use" (`Terminal.shellIntegration`, `window.onDidStartTerminalShellExecution`, `window.onDidEndTerminalShellExecution`). Notably this needs **no `engines.vscode` bump** — 1.93 is already this extension's declared floor.

## Current state in Firebird Studio

**Not started**, and the current implementation has two verified limitations that this API exists to solve.

`launchIsqlTask()` (`src/extension.ts`) — backing `firebird.terminal.connectIsql` and `firebird.terminal.runFileIsql` — builds a `vscode.Task` with a `ShellExecution` and calls `vscode.tasks.executeTask()`:

1. **It requires an open workspace folder.** The first thing the function does is bail with "Open a workspace folder to use isql in the integrated terminal." if `workspace.workspaceFolders` is empty, because `new vscode.Task(...)` needs a scope. Opening a single `.sql` file with no folder — a completely normal way to use a SQL editor — makes both isql commands unavailable for no reason intrinsic to isql.
2. **It's fire-and-forget: the exit code is never read.** `executeTask()` is awaited (which resolves when the task *starts*), and there's no `onDidEndTaskProcess` handler anywhere in the codebase. isql exits non-zero on a script error, so `firebird.terminal.runFileIsql` on a `.sql` file with a bad statement currently produces no error notification, no Background Tasks entry, and no query-history record — the user has to notice the failure in the terminal output themselves. This is a visible inconsistency with backup/restore, which *do* register with `TaskTracker` and report failure (`NodeDatabase.backupDatabase()`/`.restoreDatabase()` check `gbak`'s exit code and call `task.fail(...)`).

`buildIsqlTarget()`/`buildIsqlArgs()`/`buildIsqlEnv()`/`resolveIsqlExecutable()` are already separated out and unit-tested (`src/test/isql-terminal.test.ts`), with `src/test/suite/isql-terminal-integration.test.ts` launching a real isql binary with exactly those arguments — none of that needs to change; only the launch mechanism does.

## Proposed feature

- Replace the Task/`ShellExecution` launch with `window.createTerminal()` + `terminal.shellIntegration.executeCommand(...)`, awaiting `execution.exitCode`. That removes the workspace-folder requirement outright (a terminal has no scope) and gives the exit code the current code has no way to observe.
- **`shellIntegration` is `undefined` until the shell activates it**, and may never be for an unsupported or heavily customized shell — the implementation must handle that rather than assume it. The two options are waiting briefly on `window.onDidChangeTerminalShellIntegration` for the terminal, or falling back to `terminal.sendText()` (which loses exit codes but is never worse than today's behavior). Keeping the existing Task path as the fallback is also viable, but means maintaining two launch paths.
- **Feed the exit code into the existing `TaskTracker`**, matching what backup/restore already do — a Background Tasks entry that fails visibly, plus the same error notification style. This is the actual user-facing win; the workspace-folder fix is the incidental one.
- For `runFileIsql` specifically, `TerminalShellExecution.read()` yields the command's output stream, so isql's own error text (the useful part — "Dynamic SQL Error / Token unknown / line N") can be surfaced in the notification rather than just "exited with code 1". Worth treating as a separate step since it's the only part that needs output parsing.

## Suggested phases

1. Swap `launchIsqlTask()` to `createTerminal()` + `shellIntegration.executeCommand()` with a `sendText()` fallback when shell integration isn't available, and drop the workspace-folder guard — behavior-preserving otherwise.
2. Await `exitCode`, register the run with `TaskTracker`, and report failure the way backup/restore already do.
3. Read the execution output stream for `runFileIsql` and include isql's own error text in the failure notification.

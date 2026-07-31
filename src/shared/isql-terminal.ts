/**
 * Builds the command line / environment for launching Firebird's isql (or isql-fb) connected to
 * a saved connection, and resolves which executable to use — the Firebird analog of how the
 * PostgreSQL extension for VS Code launches `psql` in an integrated terminal. Kept free of any
 * vscode/child_process dependency so it's unit-testable; extension.ts wires the actual terminal/
 * task creation and process spawning around these pure functions.
 */

import { ConnectionOptions } from "../interfaces";

/** The database argument isql expects: `host/port:database`, or just the path when embedded. */
export function buildIsqlTarget(connectionOptions: ConnectionOptions): string {
  if (connectionOptions.embedded) {
    return connectionOptions.database;
  }
  const port = connectionOptions.port ?? 3050;
  return `${connectionOptions.host}/${port}:${connectionOptions.database}`;
}

/**
 * Builds isql's command-line arguments. Deliberately excludes -user/-password — see
 * buildIsqlEnv() — so credentials never appear in the visible terminal command line or a
 * process listing, the same reasoning the PostgreSQL extension gives for using PGPASSWORD
 * instead of an interactive/CLI password.
 */
export function buildIsqlArgs(connectionOptions: ConnectionOptions, extraArgs: string[] = []): string[] {
  const args: string[] = [...extraArgs];
  if (connectionOptions.role) {
    args.push("-role", connectionOptions.role);
  }
  args.push(buildIsqlTarget(connectionOptions));
  return args;
}

/** Environment variables Firebird's client library reads credentials from automatically. */
export function buildIsqlEnv(connectionOptions: ConnectionOptions): { ISC_USER: string; ISC_PASSWORD: string } {
  return {
    ISC_USER: connectionOptions.user,
    ISC_PASSWORD: connectionOptions.password ?? "",
  };
}

/**
 * Quotes one argument for a shell command line. Only needed on the shell-integration *fallback*
 * path (docs/roadmap/isql-terminal-shell-integration.md): `TerminalShellIntegration.executeCommand
 * (executable, args)` quotes for us, but `Terminal.sendText()` takes one raw line, and a database
 * path with a space in it would otherwise arrive as two arguments.
 */
export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value === "") {
    return platform === "win32" ? '""' : "''";
  }
  if (!/[\s"'`$&|;<>()*?!\\]/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    // cmd/PowerShell: double quotes, with embedded ones doubled.
    return `"${value.replace(/"/g, '""')}"`;
  }
  // POSIX: single quotes take everything literally; an embedded ' has to close, escape, reopen.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The full command line to type into a terminal, for the `sendText()` fallback described above. */
export function buildIsqlCommandLine(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): string {
  return [executable, ...args].map(part => quoteShellArgument(part, platform)).join(" ");
}

/**
 * Turns a failed isql run into one line worth showing the user
 * (docs/roadmap/isql-terminal-shell-integration.md, phase 3). isql reports a script error as a
 * `Statement failed, SQLSTATE = ...` line followed by `-`-prefixed detail lines — quoting those
 * back is far more useful than "exited with code 1", which is all the exit code alone can say.
 * Falls back to the exit code when the output has no recognizable Firebird error in it (the process
 * died some other way, or shell integration gave us no output to read).
 */
export function isqlReportedError(output: string): boolean {
  return output.split(/\r?\n/).some(line => isIsqlErrorLine(line.trim()));
}

function isIsqlErrorLine(line: string): boolean {
  return /^Statement failed/i.test(line) || /^Dynamic SQL Error/i.test(line) || /SQLSTATE\s*=/i.test(line);
}

/**
 * Whether an isql run should be reported as failed
 * (docs/roadmap/isql-terminal-shell-integration.md, phase 2).
 *
 * The exit code alone is **not** sufficient, confirmed against a real Firebird 6 isql rather than
 * assumed: a failing *statement* in an `-i` script exits 1 as you'd expect, but a failed *login*
 * exits **0** — isql prints `SQLSTATE = 28000 / Your user name and password are not defined`, then
 * "Use CONNECT or CREATE DATABASE to specify a database", and terminates happily. Trusting the exit
 * code by itself would silently report a completely failed run as a success, which is precisely the
 * class of bug this roadmap item exists to fix. So the output is consulted too.
 */
export function isqlRunFailed(exitCode: number | undefined, output: string): boolean {
  if (typeof exitCode === "number" && exitCode !== 0) {
    return true;
  }
  return isqlReportedError(output);
}

export function summarizeIsqlFailure(exitCode: number | undefined, output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const start = lines.findIndex(isIsqlErrorLine);

  if (start === -1) {
    return exitCode === undefined ? "isql reported a failure." : `isql exited with code ${exitCode}.`;
  }

  // The failure line plus its immediately following detail lines — capped, since a script that
  // fails on every one of 500 statements shouldn't produce a 500-line notification.
  const detail = [lines[start]];
  for (let i = start + 1; i < lines.length && detail.length < 6; i++) {
    if (!lines[i].startsWith("-") && !/^Dynamic SQL Error/i.test(lines[i])) {
      break;
    }
    detail.push(lines[i]);
  }
  return detail.join(" ");
}

/** Candidate executable names to search for on PATH, per platform (most Linux packages ship isql-fb to avoid clashing with unixODBC's own isql). */
export function isqlCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["isql.exe", "isql-fb.exe"] : ["isql-fb", "isql"];
}

/**
 * Resolves which isql executable to launch. An explicit `customPath` (the firebird.isqlPath
 * setting) always wins if it actually resolves; otherwise tries each of this platform's
 * candidate names on PATH, in order, returning the first that resolves.
 *
 * `checkExecutable` is injected (rather than spawning directly in here) so the resolution order
 * is unit-testable without a real isql binary; extension.ts supplies a real spawn-based check.
 */
export async function resolveIsqlExecutable(
  customPath: string | undefined,
  checkExecutable: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  if (customPath) {
    return (await checkExecutable(customPath)) ? customPath : undefined;
  }
  for (const candidate of isqlCandidates(platform)) {
    if (await checkExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

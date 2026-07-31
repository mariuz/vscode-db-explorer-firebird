import * as cp from "node:child_process";

/**
 * "Is this external binary really here and really the tool we mean?" — the one spawn-based probe
 * behind `resolveIsqlExecutable()`, `resolveGbakExecutable()` and `resolveDockerExecutable()`.
 *
 * Those three *resolvers* are already shared and unit-tested; what wasn't shared was the probe they
 * take as an argument, which existed as four hand-rolled copies (two of them byte-identical). Both
 * bugs this codebase has hit in probing live in that copied code, so it's now written once:
 *
 * - **stdin is always closed.** `isql -z` prints its version banner and then *reads stdin*; under
 *   `child_process.execFile` stdin is an open pipe nobody ever closes, so it never exited, hit the
 *   timeout, and a perfectly working isql was reported as missing — which made both isql commands
 *   permanently unavailable and silently skipped a whole test suite for however long it had been
 *   broken. Closing stdin turns that 3000ms timeout into a 5ms clean exit (measured). No probe
 *   should depend on the probed binary happening not to read stdin.
 * - **An expected banner can be required.** A zero exit code is not proof of identity: on Linux,
 *   plain `isql` is very often unixODBC's unrelated tool of the same name. And the reverse holds
 *   too — `gbak -z` prints its banner and *then* exits non-zero ("requires both input and output
 *   filenames"), so for gbak the exit code must be ignored and the banner is the only real signal.
 *
 * Deliberately not merged with the three resolvers themselves, which stay independent per tool —
 * this is only the part where getting it wrong is invisible until someone notices a command has
 * quietly stopped working.
 */
export interface ProbeOptions {
  /** Arguments that make the tool identify itself. */
  args: string[];
  /**
   * Case-insensitive substring the tool must print (stdout or stderr) to count as a match. Omit to
   * accept any output — only appropriate when the executable name alone is unambiguous.
   */
  expectOutput?: string;
  /**
   * Whether a zero exit code is required. `false` for tools that identify themselves and then fail
   * for an unrelated reason — `gbak -z` is exactly that case.
   */
  requireExitZero?: boolean;
  timeoutMs?: number;
}

/** Injected in tests; matches the shape of `child_process.execFile` that this module uses. */
export type ExecFileFn = typeof cp.execFile;

export function probeExecutable(
  candidate: string,
  options: ProbeOptions,
  execFile: ExecFileFn = cp.execFile
): Promise<boolean> {
  const { args, expectOutput, requireExitZero = true, timeoutMs = 3000 } = options;

  return new Promise(resolve => {
    try {
      const child = execFile(candidate, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (requireExitZero && err) {
          resolve(false);
          return;
        }
        if (!expectOutput) {
          resolve(!err);
          return;
        }
        const output = `${stdout ?? ""}${stderr ?? ""}`.toLowerCase();
        resolve(output.includes(expectOutput.toLowerCase()));
      });
      // Spawning can fail asynchronously (ENOENT for a missing binary); execFile's callback covers
      // that too, but the 'error' listener keeps an unhandled event from taking the host down.
      child.on("error", () => resolve(false));
      // The whole point — see the module comment.
      child.stdin?.end();
    } catch {
      resolve(false);
    }
  });
}

/** `isql -z` / `isql-fb -z`. Banner-checked so unixODBC's unrelated `isql` isn't mistaken for Firebird's. */
export function probeIsql(candidate: string, execFile?: ExecFileFn): Promise<boolean> {
  return probeExecutable(candidate, { args: ["-z"], expectOutput: "isql version" }, execFile);
}

/** `gbak -z`, which prints its banner and *then* exits non-zero — so the exit code can't be trusted here. */
export function probeGbak(candidate: string, execFile?: ExecFileFn): Promise<boolean> {
  return probeExecutable(
    candidate,
    { args: ["-z"], expectOutput: "gbak version", requireExitZero: false },
    execFile
  );
}

/** `docker --version`. No banner requirement: unlike `isql`, nothing else on PATH answers to `docker`. */
export function probeDocker(candidate: string, execFile?: ExecFileFn): Promise<boolean> {
  return probeExecutable(candidate, { args: ["--version"] }, execFile);
}

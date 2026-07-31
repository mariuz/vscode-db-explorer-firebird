/**
 * Extension Development Host tests for the isql terminal shell integration
 * (docs/roadmap/isql-terminal-shell-integration.md).
 *
 * `src/test/isql-terminal.test.ts` covers `buildIsqlCommandLine()`/`summarizeIsqlFailure()` as pure
 * functions with hand-written input. What can only be checked here is the part the roadmap item
 * actually exists for: that a real terminal's shell integration reports a real isql run's **exit
 * code** back to the extension (the Tasks API this replaced never could), and that
 * `summarizeIsqlFailure()`'s parsing matches what a real Firebird isql actually prints — not what
 * its error output was assumed to look like.
 *
 * Skips rather than fails when shell integration isn't available (a shell that doesn't support it,
 * or whose startup suppresses it) or when no isql binary is installed — both are environment gaps,
 * not code regressions, and the product code has a documented fallback for the first.
 */

import * as assert from 'assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isqlRunFailed, resolveIsqlExecutable, summarizeIsqlFailure } from '../../shared/isql-terminal';
import { getTestConnectionOptions } from './firebird-test-env';

function checkExecutable(candidate: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = cp.execFile(candidate, ['-z'], { timeout: 5000 }, (err, stdout, stderr) => {
        const banner = `${stdout ?? ''}${stderr ?? ''}`.toLowerCase().includes('isql version');
        resolve(!err && banner);
      });
      child.on('error', () => resolve(false));
      // Required: `isql -z` prints its banner and then reads stdin, so without an EOF it hangs
      // until the timeout and a working isql is misreported as missing. See checkIsqlExecutable()
      // in extension.ts for the full explanation — this is why this whole suite silently skipped.
      child.stdin?.end();
    } catch {
      resolve(false);
    }
  });
}

/** The same wait the product code does, duplicated here so the test exercises the real API directly. */
function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => { subscription.dispose(); resolve(undefined); }, timeoutMs);
    const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}

function waitForExit(execution: vscode.TerminalShellExecution, timeoutMs: number): Promise<number | undefined | 'timeout'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { subscription.dispose(); resolve('timeout'); }, timeoutMs);
    const subscription = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.execution === execution) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event.exitCode);
      }
    });
  });
}

suite('isql terminal shell integration (extension host)', function () {
  this.timeout(60000);

  let executable: string | undefined;
  const terminals: vscode.Terminal[] = [];

  suiteSetup(async function () {
    executable = await resolveIsqlExecutable(undefined, checkExecutable);
    if (!executable) {
      console.log('[isql-shell-integration] skipping: no isql/isql-fb binary on PATH');
    }
  });

  suiteTeardown(function () {
    terminals.forEach(terminal => terminal.dispose());
  });

  async function launch(args: string[]): Promise<{ exitCode: number | undefined | 'timeout'; output: string } | undefined> {
    const options = getTestConnectionOptions();
    const terminal = vscode.window.createTerminal({
      name: 'isql shell integration test',
      env: { ISC_USER: options.user, ISC_PASSWORD: options.password ?? '' },
    });
    terminals.push(terminal);

    const shellIntegration = await waitForShellIntegration(terminal, 15000);
    if (!shellIntegration) {
      // A skipped test should say why it skipped, or it reads as "covered" forever.
      console.log('[isql-shell-integration] skipping: this host\'s shell never reported shell integration');
      return undefined;
    }

    const execution = shellIntegration.executeCommand(executable!, args);
    let output = '';
    const reading = (async () => {
      for await (const chunk of execution.read()) {
        output += chunk;
      }
    })();
    const exitCode = await waitForExit(execution, 30000);
    await Promise.race([reading, new Promise(resolve => setTimeout(resolve, 1000))]);
    return { exitCode, output };
  }

  test('a successful isql run reports exit code 0 through the shell integration API', async function () {
    if (!executable) { this.skip(); }
    const scriptPath = path.join(os.tmpdir(), `firebird-isql-success-${process.pid}.sql`);
    fs.writeFileSync(scriptPath, 'SELECT 1 FROM RDB$DATABASE;\n');
    try {
      const options = getTestConnectionOptions();
      // A script, not `isql -z`: -z prints its banner and then waits at the isql prompt, and a
      // terminal's stdin never reaches EOF on its own, so it would simply never exit.
      const result = await launch(['-i', scriptPath, `${options.host}/${options.port}:${options.database}`]);
      if (!result) { this.skip(); }
      assert.strictEqual(result!.exitCode, 0, `expected a clean exit, got ${result!.exitCode}: ${result!.output.slice(0, 300)}`);
      assert.strictEqual(isqlRunFailed(result!.exitCode as number | undefined, result!.output), false, result!.output.slice(0, 300));
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });

  test('a failing isql script reports a non-zero exit code, which the Tasks API could never surface', async function () {
    if (!executable) { this.skip(); }
    const scriptPath = path.join(os.tmpdir(), `firebird-isql-failure-${process.pid}.sql`);
    fs.writeFileSync(scriptPath, 'SELECT * FROM THIS_TABLE_DOES_NOT_EXIST;\n');
    try {
      const options = getTestConnectionOptions();
      const target = `${options.host}/${options.port}:${options.database}`;
      const result = await launch(['-i', scriptPath, target]);
      if (!result) { this.skip(); }

      assert.notStrictEqual(result!.exitCode, 'timeout', 'isql should have exited');
      // Deliberately asserting a *number* that isn't 0: `notStrictEqual(undefined, 0)` would pass
      // vacuously if the shell never reported an exit code at all, which is the exact thing this
      // test exists to prove now works.
      assert.strictEqual(typeof result!.exitCode, 'number', `expected a real exit code, got ${result!.exitCode}`);
      assert.notStrictEqual(result!.exitCode, 0, `expected a failing exit code, got 0: ${result!.output.slice(0, 300)}`);
      assert.strictEqual(isqlRunFailed(result!.exitCode as number, result!.output), true);

      // The point of phase 3: summarize what isql *actually* printed, not just the exit code.
      const summary = summarizeIsqlFailure(result!.exitCode as number | undefined, result!.output);
      assert.ok(
        /Statement failed|SQLSTATE|Dynamic SQL Error/i.test(summary),
        `summary should quote Firebird's own error text, got: ${summary}\n--- raw output ---\n${result!.output.slice(0, 500)}`
      );
      assert.ok(!summary.startsWith('isql exited with code'), `should not have fallen back to the exit code: ${summary}`);
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });
});

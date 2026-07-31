/**
 * Extension Development Host integration tests for the isql terminal
 * integration, spawning a real isql/isql-fb binary against the real
 * Firebird test server.
 *
 * src/test/isql-terminal.test.ts covers buildIsqlTarget()/buildIsqlArgs()/
 * buildIsqlEnv()/resolveIsqlExecutable()'s logic in isolation with fake
 * data; this suite instead resolves whatever real isql binary is on the
 * runner's PATH (the Firebird 6 snapshot's own bin/ directory, added to PATH
 * by vscode-host.yml's tar.gz install step) and actually launches it with
 * exactly the arguments/environment
 * extension.ts's launchIsqlTask() would use, to prove the two integrate
 * correctly — not just that each one's output "looks right" in isolation.
 *
 * If no isql binary is available (e.g. running these tests outside CI on a
 * machine without Firebird client tools installed), the suite skips rather
 * than failing, since that's an environment gap, not a code regression.
 */

import * as assert from 'assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIsqlArgs, buildIsqlEnv, resolveIsqlExecutable, isqlCandidates } from '../../shared/isql-terminal';
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

function runIsql(executable: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      executable,
      args,
      { env: { ...process.env, ...env }, timeout: 15000 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        if (typeof code === "number") {
          // A clean non-zero process exit (e.g. isql couldn't log in) — a real, testable
          // outcome, not a test-infrastructure failure.
          resolve({ code, stdout, stderr });
          return;
        }
        // ENOENT, a killed/timed-out process, signal termination, etc.
        reject(err);
      }
    );
  });
}

suite('isql terminal integration – real isql binary against a real Firebird server', function () {
  this.timeout(30000);

  let executable: string | undefined;

  suiteSetup(async function () {
    executable = await resolveIsqlExecutable(process.env.FIREBIRD_ISQL_PATH, checkExecutable);
    if (!executable) {
      // eslint-disable-next-line no-console
      console.log(`[isql-terminal-integration] no isql binary found on PATH (tried: ${isqlCandidates().join(', ')}) — skipping.`);
    }
  });

  test('resolves a real isql (or isql-fb) executable on PATH', function () {
    if (!executable) { this.skip(); return; }
    assert.ok(isqlCandidates().includes(executable) || executable === process.env.FIREBIRD_ISQL_PATH);
  });

  test('connects to the real test server and runs a script via -i, using only env-var credentials', async function () {
    if (!executable) { this.skip(); return; }

    const conn = getTestConnectionOptions();
    const scriptPath = path.join(os.tmpdir(), `fb-isql-it-${Date.now()}.sql`);
    fs.writeFileSync(scriptPath, 'SELECT NAME, PRICE FROM PRODUCTS ORDER BY ID;\n');

    try {
      const args = buildIsqlArgs(conn, ['-i', scriptPath]);
      const env = buildIsqlEnv(conn);

      // The password must never appear in the argument list itself — this is the same
      // guarantee buildIsqlArgs()'s unit tests assert, checked again here against the args
      // actually handed to the real process.
      assert.ok(!args.some(a => a.includes(conn.password!)));

      const result = await runIsql(executable, args, env);
      assert.strictEqual(result.code, 0, `isql exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.ok(result.stdout.includes('Widget A'), `expected seeded PRODUCTS data in isql output, got:\n${result.stdout}`);
    } finally {
      fs.unlinkSync(scriptPath);
    }
  });

  test('a wrong password is rejected (env vars are actually being read, not ignored)', async function () {
    if (!executable) { this.skip(); return; }

    const conn = getTestConnectionOptions();
    const scriptPath = path.join(os.tmpdir(), `fb-isql-it-bad-${Date.now()}.sql`);
    fs.writeFileSync(scriptPath, 'SELECT 1 FROM RDB$DATABASE;\n');

    try {
      const args = buildIsqlArgs(conn, ['-i', scriptPath]);
      const env = buildIsqlEnv({ ...conn, password: 'definitely-the-wrong-password' });
      const result = await runIsql(executable, args, env);

      // Asserting on the *output*, not the exit code: this test previously expected a non-zero
      // exit and had never actually run (the -z executable check hung, so the whole suite skipped
      // — see checkExecutable() above). Once it did run, real Firebird 6 isql turned out to exit
      // **0** on an authentication failure, printing the error and then "Use CONNECT or CREATE
      // DATABASE to specify a database". A failing *statement* does exit 1; a failing *login*
      // doesn't. That's exactly why the product code's isqlRunFailed() consults the output too.
      const combined = `${result.stdout}${result.stderr}`;
      assert.ok(
        /SQLSTATE\s*=\s*28000/.test(combined) || /user name and password are not defined/i.test(combined),
        `expected an authentication error in isql's output, got (code ${result.code}):\n${combined}`
      );
    } finally {
      fs.unlinkSync(scriptPath);
    }
  });

  test('an embedded-style target (no host/port) is accepted by isql\'s argument parser', function () {
    if (!executable) { this.skip(); return; }
    const conn = getTestConnectionOptions();
    const args = buildIsqlArgs({ ...conn, embedded: true, database: conn.database });
    // Not actually connecting (no embedded engine on the runner) — just confirms the target
    // string this extension builds for embedded connections has no host/port prefix baked in,
    // matching what a real isql invocation for an embedded database expects.
    assert.strictEqual(args[args.length - 1], conn.database);
  });
});

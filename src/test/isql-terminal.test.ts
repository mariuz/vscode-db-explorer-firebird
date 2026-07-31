import * as assert from 'assert';
import {
  buildIsqlTarget,
  buildIsqlArgs,
  buildIsqlEnv,
  isqlCandidates,
  resolveIsqlExecutable,
  quoteShellArgument,
  buildIsqlCommandLine,
  summarizeIsqlFailure,
  isqlRunFailed,
  isqlReportedError,
} from '../shared/isql-terminal';
import { ConnectionOptions } from '../interfaces';

function baseConnection(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    id: 'test',
    host: 'localhost',
    port: 3050,
    database: '/data/test.fdb',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    ...overrides,
  };
}

suite('buildIsqlTarget', function () {

  test('formats a TCP connection as host/port:database', function () {
    assert.strictEqual(buildIsqlTarget(baseConnection()), 'localhost/3050:/data/test.fdb');
  });

  test('defaults to port 3050 when unset', function () {
    const target = buildIsqlTarget(baseConnection({ port: undefined }));
    assert.strictEqual(target, 'localhost/3050:/data/test.fdb');
  });

  test('uses a custom port', function () {
    const target = buildIsqlTarget(baseConnection({ host: 'db.example.com', port: 3051 }));
    assert.strictEqual(target, 'db.example.com/3051:/data/test.fdb');
  });

  test('an embedded connection is just the database path, no host/port prefix', function () {
    const target = buildIsqlTarget(baseConnection({ embedded: true, database: '/local/embedded.fdb' }));
    assert.strictEqual(target, '/local/embedded.fdb');
  });
});

suite('buildIsqlArgs', function () {

  test('with no role, the target is the only argument', function () {
    assert.deepStrictEqual(buildIsqlArgs(baseConnection()), ['localhost/3050:/data/test.fdb']);
  });

  test('includes -role before the target when a role is set', function () {
    const args = buildIsqlArgs(baseConnection({ role: 'READER' }));
    assert.deepStrictEqual(args, ['-role', 'READER', 'localhost/3050:/data/test.fdb']);
  });

  test('prepends extraArgs (e.g. -i <file>) ahead of -role and the target', function () {
    const args = buildIsqlArgs(baseConnection({ role: 'READER' }), ['-i', '/path/script.sql']);
    assert.deepStrictEqual(args, ['-i', '/path/script.sql', '-role', 'READER', 'localhost/3050:/data/test.fdb']);
  });

  test('extraArgs work without a role too', function () {
    const args = buildIsqlArgs(baseConnection(), ['-i', '/path/script.sql']);
    assert.deepStrictEqual(args, ['-i', '/path/script.sql', 'localhost/3050:/data/test.fdb']);
  });

  test('never includes -user, -password, or the raw password anywhere in the argument list', function () {
    const args = buildIsqlArgs(baseConnection({ password: 'super-secret-value', role: 'READER' }), ['-i', 'f.sql']);
    assert.ok(!args.includes('-user'));
    assert.ok(!args.includes('-password'));
    assert.ok(!args.some(a => a.includes('super-secret-value')));
  });
});

suite('buildIsqlEnv', function () {

  test('maps user/password to ISC_USER/ISC_PASSWORD', function () {
    const env = buildIsqlEnv(baseConnection({ user: 'sysdba', password: 'masterkey' }));
    assert.deepStrictEqual(env, { ISC_USER: 'sysdba', ISC_PASSWORD: 'masterkey' });
  });

  test('defaults ISC_PASSWORD to an empty string when the password is missing', function () {
    const env = buildIsqlEnv(baseConnection({ password: undefined }));
    assert.strictEqual(env.ISC_PASSWORD, '');
  });
});

suite('isqlCandidates', function () {

  test('on Windows, tries isql.exe before isql-fb.exe', function () {
    assert.deepStrictEqual(isqlCandidates('win32'), ['isql.exe', 'isql-fb.exe']);
  });

  test('on Linux/macOS, tries isql-fb before isql (avoids unixODBC\'s isql on many distros)', function () {
    assert.deepStrictEqual(isqlCandidates('linux'), ['isql-fb', 'isql']);
    assert.deepStrictEqual(isqlCandidates('darwin'), ['isql-fb', 'isql']);
  });
});

suite('resolveIsqlExecutable', function () {

  test('a working custom path is used as-is', async function () {
    const result = await resolveIsqlExecutable('/opt/firebird/bin/isql', async () => true, 'linux');
    assert.strictEqual(result, '/opt/firebird/bin/isql');
  });

  test('a custom path that fails its check returns undefined without falling back to PATH candidates', async function () {
    const calls: string[] = [];
    const result = await resolveIsqlExecutable(
      '/bad/path/isql',
      async candidate => { calls.push(candidate); return false; },
      'linux'
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(calls, ['/bad/path/isql'], 'should not have tried PATH candidates after a custom path was given');
  });

  test('with no custom path, returns the first candidate that resolves', async function () {
    const result = await resolveIsqlExecutable(undefined, async candidate => candidate === 'isql-fb', 'linux');
    assert.strictEqual(result, 'isql-fb');
  });

  test('with no custom path, falls back to the second candidate if the first is unavailable', async function () {
    const calls: string[] = [];
    const result = await resolveIsqlExecutable(
      undefined,
      async candidate => { calls.push(candidate); return candidate === 'isql'; },
      'linux'
    );
    assert.strictEqual(result, 'isql');
    assert.deepStrictEqual(calls, ['isql-fb', 'isql'], 'should try isql-fb before isql');
  });

  test('returns undefined when no candidate resolves', async function () {
    const result = await resolveIsqlExecutable(undefined, async () => false, 'linux');
    assert.strictEqual(result, undefined);
  });

  test('an empty-string custom path is treated as "no custom path" (falls back to PATH search)', async function () {
    const result = await resolveIsqlExecutable('', async candidate => candidate === 'isql-fb', 'linux');
    assert.strictEqual(result, 'isql-fb');
  });
});

suite('quoteShellArgument()/buildIsqlCommandLine() (docs/roadmap/isql-terminal-shell-integration.md, phase 1)', function () {

  test('a plain argument is left alone on both platforms', function () {
    assert.strictEqual(quoteShellArgument('localhost/3050:/tmp/test.fdb', 'linux'), 'localhost/3050:/tmp/test.fdb');
    assert.strictEqual(quoteShellArgument('isql-fb', 'win32'), 'isql-fb');
  });

  test('a path containing a space is quoted, so it stays one argument', function () {
    assert.strictEqual(quoteShellArgument('/tmp/my databases/test.fdb', 'linux'), "'/tmp/my databases/test.fdb'");
    assert.strictEqual(quoteShellArgument('C:\\My Databases\\test.fdb', 'win32'), '"C:\\My Databases\\test.fdb"');
  });

  test('POSIX quoting survives an embedded single quote', function () {
    // close, escaped literal quote, reopen — the only way single quotes can contain one
    assert.strictEqual(quoteShellArgument("/tmp/o'brien.fdb", 'linux'), `'/tmp/o'\\''brien.fdb'`);
  });

  test('Windows quoting doubles an embedded double quote', function () {
    assert.strictEqual(quoteShellArgument('a"b', 'win32'), '"a""b"');
  });

  test('an empty argument still produces an empty quoted argument, not nothing', function () {
    assert.strictEqual(quoteShellArgument('', 'linux'), "''");
    assert.strictEqual(quoteShellArgument('', 'win32'), '""');
  });

  test('shell metacharacters are quoted rather than passed through to the shell', function () {
    for (const dangerous of ['a;b', 'a|b', 'a&b', 'a$b', 'a`b', 'a>b', 'a*b']) {
      const quoted = quoteShellArgument(dangerous, 'linux');
      assert.strictEqual(quoted, `'${dangerous}'`, dangerous);
    }
  });

  test('a full command line joins the executable and every argument, each quoted', function () {
    const line = buildIsqlCommandLine('isql-fb', ['-i', '/tmp/my script.sql', 'localhost/3050:/tmp/test.fdb'], 'linux');
    assert.strictEqual(line, "isql-fb -i '/tmp/my script.sql' localhost/3050:/tmp/test.fdb");
  });
});

suite('summarizeIsqlFailure() (docs/roadmap/isql-terminal-shell-integration.md, phase 3)', function () {

  test('a real isql script failure is summarized from its own error lines, not the exit code', function () {
    const output = [
      'Database:  localhost/3050:/tmp/test.fdb',
      'SQL> SELECT * FROM NOSUCHTABLE;',
      'Statement failed, SQLSTATE = 42S02',
      'Dynamic SQL Error',
      '-SQL error code = -204',
      '-Table unknown',
      '-NOSUCHTABLE',
      '-At line 1, column 15',
    ].join('\n');
    const summary = summarizeIsqlFailure(1, output);
    assert.ok(summary.startsWith('Statement failed, SQLSTATE = 42S02'), summary);
    assert.ok(summary.includes('-Table unknown'), summary);
    assert.ok(!summary.includes('Database:'), 'preamble should not be included');
  });

  test('the detail is capped so a script failing on every statement cannot produce a huge message', function () {
    const output = ['Statement failed, SQLSTATE = 42S02', ...Array.from({ length: 50 }, (_u, i) => `-detail ${i}`)].join('\n');
    const summary = summarizeIsqlFailure(1, output);
    assert.strictEqual(summary.split(' -detail ').length - 1, 5, summary);
  });

  test('output with no recognizable Firebird error falls back to the exit code', function () {
    assert.strictEqual(summarizeIsqlFailure(2, 'some unrelated chatter'), 'isql exited with code 2.');
    assert.strictEqual(summarizeIsqlFailure(2, ''), 'isql exited with code 2.');
  });

  test('an undetermined exit code still produces a usable message', function () {
    assert.strictEqual(summarizeIsqlFailure(undefined, ''), 'isql reported a failure.');
    assert.ok(summarizeIsqlFailure(undefined, 'Statement failed, SQLSTATE = 42S02').startsWith('Statement failed'));
  });

  test('a bare SQLSTATE line is recognized even without the "Statement failed" prefix', function () {
    assert.ok(summarizeIsqlFailure(1, 'something SQLSTATE = 08006 happened').includes('SQLSTATE'));
  });
});

suite('isqlRunFailed() (docs/roadmap/isql-terminal-shell-integration.md, phase 2)', function () {
  const AUTH_FAILURE = [
    'Statement failed, SQLSTATE = 28000',
    'Your user name and password are not defined. Ask your database administrator to set up a Firebird login.',
    'After line 0 in file /tmp/ok.sql',
    'Use CONNECT or CREATE DATABASE to specify a database',
  ].join('\n');

  test('a non-zero exit code is a failure', function () {
    assert.strictEqual(isqlRunFailed(1, ''), true);
    assert.strictEqual(isqlRunFailed(2, 'anything'), true);
  });

  test('a clean run is not a failure', function () {
    assert.strictEqual(isqlRunFailed(0, ''), false);
    assert.strictEqual(isqlRunFailed(0, 'ID\n===\n 1\n'), false);
  });

  test('an authentication failure is caught despite isql exiting 0', function () {
    // Verified against a real Firebird 6 isql: a failing *statement* in an -i script exits 1, but a
    // failing *login* exits 0 while printing SQLSTATE 28000. Trusting the exit code alone would
    // report a completely failed run as a success.
    assert.strictEqual(isqlRunFailed(0, AUTH_FAILURE), true);
  });

  test('an undetermined exit code alone is not a failure, but one with error output is', function () {
    // undefined covers a plain ctrl+c out of an interactive session — not worth an error toast.
    assert.strictEqual(isqlRunFailed(undefined, ''), false);
    assert.strictEqual(isqlRunFailed(undefined, AUTH_FAILURE), true);
  });

  test('isqlReportedError() recognizes each of isql\'s error line shapes', function () {
    assert.strictEqual(isqlReportedError('Statement failed, SQLSTATE = 42S02'), true);
    assert.strictEqual(isqlReportedError('Dynamic SQL Error'), true);
    assert.strictEqual(isqlReportedError('  SQLSTATE = 08006  '), true);
    assert.strictEqual(isqlReportedError('Database:  localhost:/tmp/test.fdb\nSQL> commit;'), false);
    assert.strictEqual(isqlReportedError(''), false);
  });
});

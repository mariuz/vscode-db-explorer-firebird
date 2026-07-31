import * as assert from 'assert';
import { buildBackupFlags, gbakCandidates, resolveGbakExecutable, buildRestoreFlags, buildRestoreArgs, renderGbakCommand, buildParallelFlag, parseMaxParallelWorkers, buildMultiFileTargets, isValidVolumeSize } from '../shared/gbak-options';

suite('gbak-options – buildBackupFlags() (docs/roadmap/backup-restore-options.md, phase 1)', function () {
  test('no choices at all produces no flags — matches gbak\'s own defaults exactly', function () {
    assert.deepStrictEqual(buildBackupFlags({}), []);
  });

  test('every choice explicitly false also produces no flags', function () {
    assert.deepStrictEqual(buildBackupFlags({
      skipGarbageCollection: false, compress: false, metadataOnly: false, nonTransportable: false,
    }), []);
  });

  test('skipGarbageCollection maps to -G', function () {
    assert.deepStrictEqual(buildBackupFlags({ skipGarbageCollection: true }), ['-G']);
  });

  test('compress maps to -ZIP', function () {
    assert.deepStrictEqual(buildBackupFlags({ compress: true }), ['-ZIP']);
  });

  test('metadataOnly maps to -M', function () {
    assert.deepStrictEqual(buildBackupFlags({ metadataOnly: true }), ['-M']);
  });

  test('nonTransportable maps to -NT', function () {
    assert.deepStrictEqual(buildBackupFlags({ nonTransportable: true }), ['-NT']);
  });

  test('multiple choices combine, in the field-declaration order', function () {
    assert.deepStrictEqual(
      buildBackupFlags({ nonTransportable: true, skipGarbageCollection: true, compress: true, metadataOnly: true }),
      ['-G', '-ZIP', '-M', '-NT']
    );
  });
});

suite('gbak-options – gbakCandidates()', function () {
  test('on Windows, tries gbak.exe', function () {
    assert.deepStrictEqual(gbakCandidates('win32'), ['gbak.exe']);
  });

  test('on Linux/macOS, tries plain gbak', function () {
    assert.deepStrictEqual(gbakCandidates('linux'), ['gbak']);
    assert.deepStrictEqual(gbakCandidates('darwin'), ['gbak']);
  });
});

suite('gbak-options – resolveGbakExecutable()', function () {
  test('a working custom path is used as-is', async function () {
    const result = await resolveGbakExecutable('/opt/firebird/bin/gbak', async () => true, 'linux');
    assert.strictEqual(result, '/opt/firebird/bin/gbak');
  });

  test('a custom path that fails its check returns undefined without falling back to PATH candidates', async function () {
    const calls: string[] = [];
    const result = await resolveGbakExecutable(
      '/bad/path/gbak',
      async candidate => { calls.push(candidate); return false; },
      'linux'
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(calls, ['/bad/path/gbak']);
  });

  test('with no custom path, returns gbak when it resolves on PATH', async function () {
    const result = await resolveGbakExecutable(undefined, async candidate => candidate === 'gbak', 'linux');
    assert.strictEqual(result, 'gbak');
  });

  test('returns undefined when no candidate resolves', async function () {
    const result = await resolveGbakExecutable(undefined, async () => false, 'linux');
    assert.strictEqual(result, undefined);
  });

  test('an empty-string custom path is treated as "no custom path" (falls back to PATH search)', async function () {
    const result = await resolveGbakExecutable('', async candidate => candidate === 'gbak', 'linux');
    assert.strictEqual(result, 'gbak');
  });
});

suite('buildRestoreFlags()/buildRestoreArgs() (docs/roadmap/backup-restore-options.md, phase 2)', function () {

  test('no choices produce no modifier flags — identical to gbak\'s own defaults', function () {
    assert.deepStrictEqual(buildRestoreFlags({}), []);
  });

  test('each choice maps to the switch gbak\'s own help documents', function () {
    assert.deepStrictEqual(buildRestoreFlags({ metadataOnly: true }), ['-M']);
    assert.deepStrictEqual(buildRestoreFlags({ oneAtATime: true }), ['-O']);
    assert.deepStrictEqual(buildRestoreFlags({ noValidity: true }), ['-N']);
    assert.deepStrictEqual(buildRestoreFlags({ noShadows: true }), ['-K']);
  });

  test('page size is a flag *and* a value, not a bare switch', function () {
    assert.deepStrictEqual(buildRestoreFlags({ pageSize: 16384 }), ['-P', '16384']);
    assert.deepStrictEqual(buildRestoreFlags({ pageSize: undefined }), []);
    assert.deepStrictEqual(buildRestoreFlags({ pageSize: 0 }), [], '0 is not a page size — treat as unset');
  });

  test('multiple choices combine in a stable order', function () {
    assert.deepStrictEqual(
      buildRestoreFlags({ metadataOnly: true, oneAtATime: true, noValidity: true, noShadows: true, pageSize: 8192 }),
      ['-M', '-O', '-N', '-K', '-P', '8192']
    );
  });

  test('create mode uses -C, replace mode uses -REP — a top-level switch, never both', function () {
    const base = { choices: {}, user: 'sysdba', password: 'masterkey', backupPaths: ['/tmp/b.fbk'], target: 'localhost/3050:/tmp/t.fdb' };
    const created = buildRestoreArgs({ ...base, mode: 'create' });
    const replaced = buildRestoreArgs({ ...base, mode: 'replace' });
    assert.strictEqual(created[0], '-C');
    assert.strictEqual(replaced[0], '-REP');
    assert.ok(!created.includes('-REP'));
    assert.ok(!replaced.includes('-C'));
  });

  test('the full argument list keeps gbak\'s expected order: mode, flags, credentials, source, target', function () {
    const args = buildRestoreArgs({
      mode: 'replace',
      choices: { noValidity: true, pageSize: 4096 },
      user: 'sysdba',
      password: 'masterkey',
      backupPaths: ['/tmp/b.fbk'],
      target: 'localhost/3050:/tmp/t.fdb',
    });
    assert.deepStrictEqual(args, [
      '-REP', '-N', '-P', '4096',
      '-user', 'sysdba', '-password', 'masterkey',
      '/tmp/b.fbk', 'localhost/3050:/tmp/t.fdb',
    ]);
  });

  test('an options-free restore produces exactly the argument list this command used before phase 2', function () {
    // The pre-phase-2 behavior was ["-c", "-user", u, "-password", p, backup, target]; nothing but
    // the switch's letter case changes when no option is picked.
    const args = buildRestoreArgs({
      mode: 'create', choices: {}, user: 'sysdba', password: 'pw',
      backupPaths: ['/tmp/b.fbk'], target: 'localhost/3050:/tmp/t.fdb',
    });
    assert.deepStrictEqual(args, ['-C', '-user', 'sysdba', '-password', 'pw', '/tmp/b.fbk', 'localhost/3050:/tmp/t.fdb']);
  });
});

suite('renderGbakCommand() (command preview)', function () {

  test('the password is redacted — the preview exists to be shown to a human', function () {
    const rendered = renderGbakCommand('gbak', ['-C', '-user', 'sysdba', '-password', 'hunter2', '/tmp/b.fbk', 'localhost/3050:/tmp/t.fdb']);
    assert.ok(!rendered.includes('hunter2'), rendered);
    assert.ok(rendered.includes('-password ********'), rendered);
  });

  test('every other argument is shown verbatim, so the preview matches what will run', function () {
    const args = buildRestoreArgs({
      mode: 'replace', choices: { metadataOnly: true }, user: 'sysdba', password: 'pw',
      backupPaths: ['/tmp/b.fbk'], target: 'localhost/3050:/tmp/t.fdb',
    });
    const rendered = renderGbakCommand('gbak', args);
    assert.strictEqual(rendered, 'gbak -REP -M -user sysdba -password ******** /tmp/b.fbk localhost/3050:/tmp/t.fdb');
  });

  test('paths containing spaces are quoted so the preview is unambiguous', function () {
    const rendered = renderGbakCommand('/opt/fb bin/gbak', ['-C', '/tmp/my backup.fbk']);
    assert.strictEqual(rendered, '"/opt/fb bin/gbak" -C "/tmp/my backup.fbk"');
  });

  test('a value that merely looks like a password elsewhere is not redacted', function () {
    // Only the token immediately after -password is a password; a database named "-password" is
    // not a realistic case, but a *value* equal to another argument is.
    const rendered = renderGbakCommand('gbak', ['-user', 'pw', '-password', 'pw', '/tmp/pw.fbk']);
    assert.strictEqual(rendered, 'gbak -user pw -password ******** /tmp/pw.fbk');
  });
});

suite('parallel workers & multi-file backup (docs/roadmap/backup-restore-options.md, phase 4)', function () {

  test('one worker (or none) emits no flag — 1 is gbak\'s own default', function () {
    assert.deepStrictEqual(buildParallelFlag(undefined), []);
    assert.deepStrictEqual(buildParallelFlag(1), []);
    assert.deepStrictEqual(buildParallelFlag(0), []);
  });

  test('more than one worker emits -PAR <n>', function () {
    assert.deepStrictEqual(buildParallelFlag(4), ['-PAR', '4']);
  });

  test('parseMaxParallelWorkers() reads the RDB$CONFIG row, and falls back to 1 for anything unusable', function () {
    // The live shape: RDB$CONFIG_VALUE comes back as a string, aliased MAX_WORKERS.
    assert.strictEqual(parseMaxParallelWorkers([{ MAX_WORKERS: '8' }]), 8);
    assert.strictEqual(parseMaxParallelWorkers([{ MAX_WORKERS: 4 }]), 4);
    assert.strictEqual(parseMaxParallelWorkers([{ MAX_WORKERS: '1' }]), 1);
    assert.strictEqual(parseMaxParallelWorkers([{ MAX_WORKERS: 'nonsense' }]), 1);
    assert.strictEqual(parseMaxParallelWorkers([{}]), 1);
    assert.strictEqual(parseMaxParallelWorkers([]), 1);
    assert.strictEqual(parseMaxParallelWorkers(undefined), 1);
  });

  test('a single volume is exactly the pre-phase-4 single-file argument', function () {
    assert.deepStrictEqual(buildMultiFileTargets('/tmp/backup.fbk', 1, '500m'), ['/tmp/backup.fbk']);
    assert.deepStrictEqual(buildMultiFileTargets('/tmp/backup.fbk', 0, '500m'), ['/tmp/backup.fbk']);
  });

  test('multiple volumes interleave file and size, with no size on the last one', function () {
    // gbak's own form: `file1 <size> file2 <size> … fileN` — the last volume takes what's left.
    assert.deepStrictEqual(buildMultiFileTargets('/tmp/backup.fbk', 3, '500m'), [
      '/tmp/backup.fbk', '500m',
      '/tmp/backup.2.fbk', '500m',
      '/tmp/backup.3.fbk',
    ]);
  });

  test('volume names keep the original extension so each part stays recognizable', function () {
    const targets = buildMultiFileTargets('/tmp/my.backup.fbk', 2, '1g');
    assert.deepStrictEqual(targets, ['/tmp/my.backup.fbk', '1g', '/tmp/my.backup.2.fbk']);
  });

  test('a path with no extension still produces distinct volume names', function () {
    assert.deepStrictEqual(buildMultiFileTargets('/tmp/backup', 2, '1g'), ['/tmp/backup', '1g', '/tmp/backup.2']);
  });

  test('isValidVolumeSize() accepts gbak\'s own size forms and rejects the rest', function () {
    for (const good of ['500m', '2g', '1024k', '4096', '500M', '2G']) {
      assert.strictEqual(isValidVolumeSize(good), true, good);
    }
    for (const bad of ['', 'lots', '500mb', '-5m', '1.5g', '500 m']) {
      assert.strictEqual(isValidVolumeSize(bad), false, bad);
    }
  });

  test('a restore lists every volume, in order, ahead of the target', function () {
    const args = buildRestoreArgs({
      mode: 'create', choices: {}, user: 'sysdba', password: 'pw',
      backupPaths: ['/tmp/b.fbk', '/tmp/b.2.fbk', '/tmp/b.3.fbk'],
      target: 'localhost/3050:/tmp/t.fdb',
    });
    assert.deepStrictEqual(args, [
      '-C', '-user', 'sysdba', '-password', 'pw',
      '/tmp/b.fbk', '/tmp/b.2.fbk', '/tmp/b.3.fbk',
      'localhost/3050:/tmp/t.fdb',
    ]);
  });

  test('a restore can combine parallel workers with restore flags', function () {
    const args = buildRestoreArgs({
      mode: 'replace', choices: { noValidity: true }, user: 'sysdba', password: 'pw',
      backupPaths: ['/tmp/b.fbk'], target: 'localhost/3050:/tmp/t.fdb', parallelWorkers: 4,
    });
    assert.deepStrictEqual(args, [
      '-REP', '-N', '-PAR', '4', '-user', 'sysdba', '-password', 'pw',
      '/tmp/b.fbk', 'localhost/3050:/tmp/t.fdb',
    ]);
  });
});

import * as assert from 'assert';
import { probeExecutable, probeIsql, probeGbak, probeDocker } from '../shared/executable-probe';

/**
 * These spawn *real* subprocesses — `process.execPath -e <script>` — rather than mocking
 * child_process. That's deliberate: every bug this helper exists to prevent was a bug about how a
 * real process actually behaves (reading stdin, exiting non-zero after printing its banner), and a
 * mock would have happily reproduced the wrong assumption. Using Node itself as the stand-in binary
 * keeps them deterministic and dependency-free, with no isql/gbak/docker required.
 */

/** A fake "binary": a Node one-liner. Returns args suitable for probeExecutable's `args`. */
function script(body: string): string[] {
  return ['-e', body];
}

const NODE = process.execPath;

suite('probeExecutable() — the shared spawn probe (src/shared/executable-probe.ts)', function () {
  this.timeout(20000);

  test('a tool that prints the expected banner and exits 0 is accepted', async function () {
    const ok = await probeExecutable(NODE, {
      args: script('console.log("ISQL Version: LI-T6.0.0")'),
      expectOutput: 'isql version',
    });
    assert.strictEqual(ok, true);
  });

  test('a tool that exits 0 but prints something else is rejected', async function () {
    // The unixODBC-`isql`-on-PATH case: right name, wrong program.
    const ok = await probeExecutable(NODE, {
      args: script('console.log("unixODBC isql, a totally different tool")'),
      expectOutput: 'isql version',
    });
    assert.strictEqual(ok, false);
  });

  test('a banner on stderr counts too — tools are inconsistent about which stream they use', async function () {
    const ok = await probeExecutable(NODE, {
      args: script('console.error("gbak:gbak version LI-T6.0.0")'),
      expectOutput: 'gbak version',
      requireExitZero: false,
    });
    assert.strictEqual(ok, true);
  });

  test('requireExitZero:false accepts a tool that identifies itself and then fails', async function () {
    // Exactly gbak -z: prints its banner, then exits non-zero because -z alone isn't a full command.
    const ok = await probeExecutable(NODE, {
      args: script('console.log("gbak:gbak version LI-T6.0.0"); process.exit(1)'),
      expectOutput: 'gbak version',
      requireExitZero: false,
    });
    assert.strictEqual(ok, true);
  });

  test('the same non-zero exit IS rejected when requireExitZero is left on', async function () {
    const ok = await probeExecutable(NODE, {
      args: script('console.log("gbak:gbak version LI-T6.0.0"); process.exit(1)'),
      expectOutput: 'gbak version',
    });
    assert.strictEqual(ok, false);
  });

  test('a tool that reads stdin still completes, because the probe closes it', async function () {
    // THE regression test. `isql -z` prints its banner and then reads stdin; with stdin left open
    // it never exits, the probe times out, and a working binary is reported as missing. This
    // script exits only once stdin reaches EOF — so it passes only because the probe closes stdin.
    const started = Date.now();
    const ok = await probeExecutable(NODE, {
      args: script('console.log("ISQL Version: LI-T6.0.0"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'),
      expectOutput: 'isql version',
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(ok, true, 'a stdin-reading tool must still be detected');
    assert.ok(elapsed < 4000, `should exit promptly on EOF, not hit the timeout (took ${elapsed}ms)`);
  });

  test('a tool that hangs regardless of stdin is rejected via the timeout, not left pending', async function () {
    const ok = await probeExecutable(NODE, {
      args: script('console.log("ISQL Version: x"); setTimeout(() => {}, 60000)'),
      expectOutput: 'isql version',
      timeoutMs: 700,
    });
    assert.strictEqual(ok, false);
  });

  test('a missing binary resolves false rather than throwing or hanging', async function () {
    assert.strictEqual(await probeExecutable('definitely-not-a-real-binary-xyz', { args: ['--version'] }), false);
  });

  test('with no expectOutput, a clean exit is enough and a failing one is not', async function () {
    assert.strictEqual(await probeExecutable(NODE, { args: script('console.log("Docker version 27.0.0")') }), true);
    assert.strictEqual(await probeExecutable(NODE, { args: script('process.exit(1)') }), false);
  });

  test('a synchronous throw from execFile is contained', async function () {
    const throwing = (() => { throw new Error('spawn EIO'); }) as any;
    assert.strictEqual(await probeExecutable('anything', { args: ['--version'] }, throwing), false);
  });
});

suite('probeIsql/probeGbak/probeDocker — the per-tool presets', function () {
  this.timeout(20000);

  /** Captures what each preset asks execFile for, without spawning anything. */
  function capture() {
    const calls: { file: string; args: string[]; options: any }[] = [];
    const fake = ((file: string, args: string[], options: any, callback: any) => {
      calls.push({ file, args, options });
      callback(null, '', '');
      return { on() { /* no 'error' in this fake */ }, stdin: { end() { /* noop */ } } } as any;
    }) as any;
    return { calls, fake };
  }

  test('probeIsql asks for -z and requires the isql banner', async function () {
    const { calls, fake } = capture();
    await probeIsql('isql-fb', fake);
    assert.deepStrictEqual(calls[0].args, ['-z']);
    // An empty-output success must be rejected, which proves a banner is actually required.
    assert.strictEqual(await probeIsql('isql-fb', fake), false);
  });

  test('probeGbak asks for -z and tolerates a non-zero exit', async function () {
    const calls: any[] = [];
    const fake = ((_file: string, args: string[], _options: any, callback: any) => {
      calls.push(args);
      callback(new Error('exit 1'), 'gbak:gbak version LI-T6.0.0', '');
      return { on() { /* noop */ }, stdin: { end() { /* noop */ } } } as any;
    }) as any;
    assert.strictEqual(await probeGbak('gbak', fake), true, 'gbak identifies itself then exits non-zero');
    assert.deepStrictEqual(calls[0], ['-z']);
  });

  test('probeDocker asks for --version and accepts any output', async function () {
    const { calls, fake } = capture();
    assert.strictEqual(await probeDocker('docker', fake), true);
    assert.deepStrictEqual(calls[0].args, ['--version']);
  });

  test('every preset closes stdin — the invariant the isql bug came from', async function () {
    for (const [name, preset] of [['isql', probeIsql], ['gbak', probeGbak], ['docker', probeDocker]] as const) {
      let closed = false;
      const fake = ((_f: string, _a: string[], _o: any, callback: any) => {
        callback(null, 'isql version gbak version', '');
        return { on() { /* noop */ }, stdin: { end() { closed = true; } } } as any;
      }) as any;
      await preset('x', fake);
      assert.strictEqual(closed, true, `${name} must close stdin`);
    }
  });
});

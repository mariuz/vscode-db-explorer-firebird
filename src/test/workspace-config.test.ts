import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseWorkspaceConfig, workspaceConnectionId, loadWorkspaceConnections } from '../shared/workspace-config';
import { workspace } from 'vscode';

// ── parseWorkspaceConfig() — pure, no fs/vscode access ────────────────────────

suite('parseWorkspaceConfig()', function () {

  test('parses a full network connection entry', function () {
    const json = JSON.stringify({
      connections: [
        { name: 'Local Dev', host: 'localhost', port: 3051, database: 'data/test.fdb', user: 'ALICE', role: 'ADMIN', wireCrypt: 'Required', default: true },
      ],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.host, 'localhost');
    assert.strictEqual(conn.port, 3051);
    assert.strictEqual(conn.database, path.join('/proj', 'data/test.fdb'));
    assert.strictEqual(conn.user, 'ALICE');
    assert.strictEqual(conn.role, 'ADMIN');
    assert.strictEqual(conn.wireCrypt, 'Required');
    assert.strictEqual(conn.workspace, true);
    assert.strictEqual(conn.isDefault, true);
    assert.strictEqual(conn.embedded, false);
  });

  test('resolves a relative database path against the folder path', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: 'db/test.fdb' }] });
    const [conn] = parseWorkspaceConfig(json, '/home/user/proj', 'proj');
    assert.strictEqual(conn.database, path.join('/home/user/proj', 'db/test.fdb'));
  });

  test('leaves an absolute database path unchanged', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: '/var/lib/firebird/test.fdb' }] });
    const [conn] = parseWorkspaceConfig(json, '/home/user/proj', 'proj');
    assert.strictEqual(conn.database, '/var/lib/firebird/test.fdb');
  });

  test('an embedded connection needs no "host"', function () {
    const json = JSON.stringify({ connections: [{ embedded: true, database: 'local.fdb' }] });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.embedded, true);
    assert.strictEqual(conn.host, '');
    assert.strictEqual(conn.port, null);
  });

  test('defaults user to SYSDBA, port to 3050, and isDefault to false when omitted', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: 'test.fdb' }] });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.user, 'SYSDBA');
    assert.strictEqual(conn.port, 3050);
    assert.strictEqual(conn.isDefault, false);
  });

  test('skips an entry missing "database" instead of throwing', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost' }] });
    assert.deepStrictEqual(parseWorkspaceConfig(json, '/proj', 'proj'), []);
  });

  test('skips a non-embedded entry missing "host" instead of throwing', function () {
    const json = JSON.stringify({ connections: [{ database: 'test.fdb' }] });
    assert.deepStrictEqual(parseWorkspaceConfig(json, '/proj', 'proj'), []);
  });

  test('a "password" field is ignored, never surfacing in the parsed connection', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: 'test.fdb', password: 'hunter2' }] });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual((conn as any).password, undefined);
  });

  test('an unrecognized wireCrypt value is ignored rather than passed through', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: 'test.fdb', wireCrypt: 'Nonsense' }] });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.wireCrypt, undefined);
  });

  test('processes remaining valid entries even when one is skipped', function () {
    const json = JSON.stringify({
      connections: [
        { host: 'localhost', database: 'ok1.fdb' },
        { database: 'bad-no-host.fdb' },
        { host: 'localhost', database: 'ok2.fdb' },
      ],
    });
    const results = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(results.length, 2);
  });

  test('throws on malformed JSON', function () {
    assert.throws(() => parseWorkspaceConfig('{ not valid json', '/proj', 'proj'), /invalid JSON/);
  });

  test('throws when there is no top-level "connections" array', function () {
    assert.throws(() => parseWorkspaceConfig(JSON.stringify({ foo: 'bar' }), '/proj', 'proj'), /connections/);
  });
});

// ── parseWorkspaceConfig() — "sshTunnel" field (docs/roadmap/ssh-tunneling.md) ─

suite('parseWorkspaceConfig() – sshTunnel', function () {

  test('is undefined when the entry has no "sshTunnel" field at all', function () {
    const json = JSON.stringify({ connections: [{ host: 'localhost', database: 'test.fdb' }] });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.sshTunnel, undefined);
  });

  test('parses a full "password"-auth sshTunnel', function () {
    const json = JSON.stringify({
      connections: [{
        host: 'db-internal', database: 'test.fdb',
        sshTunnel: { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'password' },
      }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.deepStrictEqual(conn.sshTunnel, { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'password' });
  });

  test('parses a "privateKey"-auth sshTunnel, carrying privateKeyPath through', function () {
    const json = JSON.stringify({
      connections: [{
        host: 'db-internal', database: 'test.fdb',
        sshTunnel: { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' },
      }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.deepStrictEqual(conn.sshTunnel, {
      host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519',
    });
  });

  test('parses an "agent"-auth sshTunnel with no privateKeyPath needed', function () {
    const json = JSON.stringify({
      connections: [{
        host: 'db-internal', database: 'test.fdb',
        sshTunnel: { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'agent' },
      }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.deepStrictEqual(conn.sshTunnel, { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'agent' });
  });

  test('ignores a "password" field nested inside sshTunnel — never accept a committed SSH secret', function () {
    const json = JSON.stringify({
      connections: [{
        host: 'db-internal', database: 'test.fdb',
        sshTunnel: { host: 'bastion.example.com', port: 22, user: 'deploy', authMethod: 'password', password: 'hunter2' },
      }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual((conn.sshTunnel as any).password, undefined);
  });

  test('the connection itself still loads when sshTunnel is missing "host" — only the tunnel is dropped', function () {
    const json = JSON.stringify({
      connections: [{ host: 'db-internal', database: 'test.fdb', sshTunnel: { port: 22, user: 'deploy', authMethod: 'password' } }],
    });
    const results = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].sshTunnel, undefined);
    assert.strictEqual(results[0].host, 'db-internal');
  });

  test('drops the tunnel when "authMethod" is invalid', function () {
    const json = JSON.stringify({
      connections: [{ host: 'db-internal', database: 'test.fdb', sshTunnel: { host: 'bastion', port: 22, user: 'deploy', authMethod: 'kerberos' } }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.sshTunnel, undefined);
  });

  test('drops the tunnel when authMethod is "privateKey" but privateKeyPath is missing', function () {
    const json = JSON.stringify({
      connections: [{ host: 'db-internal', database: 'test.fdb', sshTunnel: { host: 'bastion', port: 22, user: 'deploy', authMethod: 'privateKey' } }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.sshTunnel, undefined);
  });

  test('drops the tunnel when "port" is not a number', function () {
    const json = JSON.stringify({
      connections: [{ host: 'db-internal', database: 'test.fdb', sshTunnel: { host: 'bastion', port: '22', user: 'deploy', authMethod: 'password' } }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.sshTunnel, undefined);
  });

  test('drops an sshTunnel declared on an "embedded" entry — no network host to tunnel to', function () {
    const json = JSON.stringify({
      connections: [{ embedded: true, database: 'local.fdb', sshTunnel: { host: 'bastion', port: 22, user: 'deploy', authMethod: 'password' } }],
    });
    const [conn] = parseWorkspaceConfig(json, '/proj', 'proj');
    assert.strictEqual(conn.embedded, true);
    assert.strictEqual(conn.sshTunnel, undefined);
  });
});

// ── workspaceConnectionId() ────────────────────────────────────────────────────

suite('workspaceConnectionId()', function () {

  test('is deterministic for the same inputs', function () {
    const a = workspaceConnectionId(false, 'localhost', 3050, '/proj/db.fdb', 'SYSDBA');
    const b = workspaceConnectionId(false, 'localhost', 3050, '/proj/db.fdb', 'SYSDBA');
    assert.strictEqual(a, b);
  });

  test('differs when the database path differs', function () {
    const a = workspaceConnectionId(false, 'localhost', 3050, '/proj/db1.fdb', 'SYSDBA');
    const b = workspaceConnectionId(false, 'localhost', 3050, '/proj/db2.fdb', 'SYSDBA');
    assert.notStrictEqual(a, b);
  });

  test('embedded connections ignore host in the key', function () {
    const a = workspaceConnectionId(true, 'irrelevant-host-a', undefined, '/proj/db.fdb', 'SYSDBA');
    const b = workspaceConnectionId(true, 'irrelevant-host-b', undefined, '/proj/db.fdb', 'SYSDBA');
    assert.strictEqual(a, b);
  });

  test('is prefixed so it can never collide with a globalState uuid-v1 id', function () {
    assert.ok(workspaceConnectionId(false, 'localhost', 3050, '/proj/db.fdb', 'SYSDBA').startsWith('workspace:'));
  });
});

// ── loadWorkspaceConnections() — reads real files from a temp workspace folder ───

suite('loadWorkspaceConnections()', function () {
  let tmpDir: string;

  setup(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firebird-workspace-config-test-'));
    (workspace as any).workspaceFolders = [{ name: 'tmp', uri: { fsPath: tmpDir } }];
  });

  teardown(function () {
    (workspace as any).workspaceFolders = undefined;
    delete (workspace as any).isTrusted;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns an empty array when there are no workspace folders', async function () {
    (workspace as any).workspaceFolders = undefined;
    assert.deepStrictEqual(await loadWorkspaceConnections(), []);
  });

  test('returns an empty array when the folder has no .vscode/firebird.json', async function () {
    assert.deepStrictEqual(await loadWorkspaceConnections(), []);
  });

  test('reads and parses a real .vscode/firebird.json from disk', async function () {
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.vscode', 'firebird.json'),
      JSON.stringify({ connections: [{ host: 'localhost', database: 'test.fdb', default: true }] })
    );
    const conns = await loadWorkspaceConnections();
    assert.strictEqual(conns.length, 1);
    assert.strictEqual(conns[0].database, path.join(tmpDir, 'test.fdb'));
    assert.strictEqual(conns[0].isDefault, true);
  });

  test('does not throw on invalid JSON — logs and returns an empty array', async function () {
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'firebird.json'), '{ not valid json');
    assert.deepStrictEqual(await loadWorkspaceConnections(), []);
  });

  suite('Workspace Trust', function () {
    const config = JSON.stringify({
      connections: [{ name: 'Staging', host: 'db.example.com', database: '/srv/app.fdb' }],
    });

    test('an untrusted folder\'s connections are withheld', async function () {
      // The file cannot carry a password by design, so a malicious repository's entry would instead
      // *prompt* for one — a connection called "Staging" pointing at a server the attacker controls,
      // with the user typing real credentials into it. This is the whole reason the extension
      // declares `untrustedWorkspaces: "limited"` rather than full support.
      fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.vscode', 'firebird.json'), config);
      (workspace as any).isTrusted = false;
      assert.deepStrictEqual(await loadWorkspaceConnections(), []);
    });

    test('a trusted folder\'s connections load normally', async function () {
      fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.vscode', 'firebird.json'), config);
      (workspace as any).isTrusted = true;
      const connections = await loadWorkspaceConnections();
      assert.strictEqual(connections.length, 1);
      assert.strictEqual(connections[0].host, 'db.example.com');
    });

    test('an older VS Code with no trust API is treated as trusted', async function () {
      // `isTrusted` is undefined on hosts that predate Workspace Trust. Treating unknown as
      // untrusted would silently break workspace connections for those users; the check is
      // deliberately `=== false`, not falsy.
      fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.vscode', 'firebird.json'), config);
      delete (workspace as any).isTrusted;
      assert.strictEqual((await loadWorkspaceConnections()).length, 1);
    });
  });
});

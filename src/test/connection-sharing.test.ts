/**
 * Unit tests for connection-sharing (docs/roadmap/cross-extension-connection-api.md, phase 1).
 * Uses the vscode mock's createMockContext() the same way bookmark-provider.test.ts does.
 */

import * as assert from 'assert';
import { listConnections, getActiveConnection } from '../connection-sharing';
import { createMockContext } from './mocks/vscode';
import { Global } from '../shared/global';
import { ConnectionOptions } from '../interfaces';

function conn(overrides: Partial<ConnectionOptions>): ConnectionOptions {
  return {
    id: 'id-1',
    host: 'localhost',
    port: 3050,
    database: '/var/lib/firebird/data/employee.fdb',
    user: 'sysdba',
    password: 'super-secret-value',
    role: null,
    embedded: false,
    ...overrides,
  };
}

suite('connection-sharing – listConnections()', function () {
  test('returns an empty array when there are no saved connections', async function () {
    const ctx = createMockContext() as any;
    const result = await listConnections(ctx);
    assert.deepStrictEqual(result, []);
  });

  test('returns id/label/host/database/embedded for a saved connection', async function () {
    const ctx = createMockContext() as any;
    await ctx.globalState.update('firebird.connections', {
      'abc': conn({ id: 'abc', host: 'db.example.com', database: '/data/prod.fdb' }),
    });

    const result = await listConnections(ctx);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'abc');
    assert.strictEqual(result[0].host, 'db.example.com');
    assert.strictEqual(result[0].database, '/data/prod.fdb');
    assert.strictEqual(result[0].embedded, false);
    assert.ok(result[0].label.length > 0);
  });

  test('never includes the password, under any key name', async function () {
    const ctx = createMockContext() as any;
    await ctx.globalState.update('firebird.connections', {
      'abc': conn({ id: 'abc', password: 'super-secret-value' }),
    });

    const [info] = await listConnections(ctx);
    const serialized = JSON.stringify(info);
    assert.ok(!serialized.includes('super-secret-value'), serialized);
    assert.ok(!('password' in info));
  });

  test('lists every saved connection, not just the first', async function () {
    const ctx = createMockContext() as any;
    await ctx.globalState.update('firebird.connections', {
      'a': conn({ id: 'a', database: '/data/a.fdb' }),
      'b': conn({ id: 'b', database: '/data/b.fdb' }),
    });

    const result = await listConnections(ctx);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result.map(r => r.id).sort(), ['a', 'b']);
  });

  test('an embedded connection is reported as embedded: true', async function () {
    const ctx = createMockContext() as any;
    await ctx.globalState.update('firebird.connections', {
      'e': conn({ id: 'e', embedded: true, host: '', database: '/local/test.fdb' }),
    });

    const [info] = await listConnections(ctx);
    assert.strictEqual(info.embedded, true);
  });
});

suite('connection-sharing – getActiveConnection()', function () {
  // Reset both the global active connection and the editor-connections map before each test in
  // this suite so that state leaked from listConnections() tests doesn't affect ordering-sensitive
  // assertions.
  suiteSetup(function () {
    (Global as any)._globalActiveConnection = undefined;
    (Global as any).editorConnections = new Map();
  });
  suiteTeardown(function () {
    (Global as any)._globalActiveConnection = undefined;
    (Global as any).editorConnections = new Map();
  });

  test('returns undefined when nothing is active yet', function () {
    assert.strictEqual(getActiveConnection(), undefined);
  });

  test('returns the active connection\'s shared info once one is set', function () {
    Global.activeConnection = conn({ id: 'active-1', host: 'active-host', database: '/data/active.fdb' });
    const info = getActiveConnection();
    assert.ok(info);
    assert.strictEqual(info!.id, 'active-1');
    assert.strictEqual(info!.host, 'active-host');
    assert.strictEqual(info!.database, '/data/active.fdb');
  });

  test('never includes the password', function () {
    Global.patchActiveConnection({ id: 'active-2', password: 'super-secret-value' });
    const info = getActiveConnection();
    assert.ok(info);
    assert.ok(!('password' in info!));
    assert.ok(!JSON.stringify(info).includes('super-secret-value'));
  });
});

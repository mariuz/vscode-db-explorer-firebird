import * as assert from 'assert';
import { window } from 'vscode';
import { createMockContext } from './mocks/vscode';
import { connectionPicker, pickConnectionOptions } from '../shared/connection-picker';
import { Global } from '../shared/global';
import { Constants } from '../config/constants';
import { NodeDatabase } from '../nodes';
import { ConnectionOptions } from '../interfaces';

suite('Connection Picker — Recent & Default Connections', function () {
  let ctx: any;
  let showQuickPickOriginal: any;
  let capturedItems: any[] = [];

  setup(function () {
    ctx = createMockContext();
    Global.context = ctx;
    showQuickPickOriginal = window.showQuickPick;
    capturedItems = [];
    window.showQuickPick = (items: any, options?: any) => {
      capturedItems = items;
      return Promise.resolve(undefined);
    };
  });

  teardown(function () {
    window.showQuickPick = showQuickPickOriginal;
    (Global as any)._activeConnection = undefined;
  });

  const conn1: ConnectionOptions = { id: 'c1', host: 'localhost', database: 'db1.fdb', user: 'SYSDBA', port: 3050, role: '' };
  const conn2: ConnectionOptions = { id: 'c2', host: '127.0.0.1', database: 'db2.fdb', user: 'SYSDBA', port: 3050, role: '' };
  const conn3: ConnectionOptions = { id: 'c3', host: 'remotehost', database: 'db3.fdb', user: 'SYSDBA', isDefault: true, port: 3050, role: '' };

  test('groups connections in connectionPicker by recency and indicates default with ★', async function () {
    // Save connections to globalState
    const saved = {
      c1: conn1,
      c2: conn2,
      c3: conn3
    };
    await ctx.globalState.update(Constants.ConectionsKey, saved);

    // Save recent connection history
    await ctx.globalState.update(Constants.RecentConnectionsKey, ['c2']);

    await connectionPicker(ctx);

    assert.strictEqual(capturedItems.length, 5); // separator "Recent", c2, separator "Other", c1, c3
    assert.strictEqual(capturedItems[0].label, 'Recent Connections');
    assert.strictEqual(capturedItems[0].kind, -1); // Separator

    assert.strictEqual(capturedItems[1].label, '127.0.0.1:db2.fdb'); // c2 label
    assert.strictEqual(capturedItems[1].detail, 'connection id: c2');

    assert.strictEqual(capturedItems[2].label, 'Other Connections');
    assert.strictEqual(capturedItems[2].kind, -1); // Separator

    assert.strictEqual(capturedItems[3].label, 'localhost:db1.fdb'); // c1 label
    assert.strictEqual(capturedItems[4].label, 'remotehost:db3.fdb ★'); // c3 label (default indicator!)
  });

  test('pickConnectionOptions also groups and formats connections consistently', async function () {
    const saved = {
      c1: conn1,
      c2: conn2,
      c3: conn3
    };
    await ctx.globalState.update(Constants.ConectionsKey, saved);
    await ctx.globalState.update(Constants.RecentConnectionsKey, ['c1']);

    await pickConnectionOptions(ctx);

    assert.strictEqual(capturedItems.length, 5);
    assert.strictEqual(capturedItems[0].label, 'Recent Connections');
    assert.strictEqual(capturedItems[1].label, 'localhost:db1.fdb');
    assert.strictEqual(capturedItems[1].id, 'c1');
    assert.strictEqual(capturedItems[2].label, 'Other Connections');
    assert.strictEqual(capturedItems[3].label, '127.0.0.1:db2.fdb');
    assert.strictEqual(capturedItems[4].label, 'remotehost:db3.fdb ★');
  });

  test('setting active connection updates recent history in globalState', async function () {
    const saved = {
      c1: conn1,
      c2: conn2
    };
    await ctx.globalState.update(Constants.ConectionsKey, saved);

    // Set active connection via Global setter
    Global.activeConnection = { ...conn2, id: 'c2' };

    const recent = ctx.globalState.get(Constants.RecentConnectionsKey);
    assert.deepStrictEqual(recent, ['c2']);

    // Set another active connection
    Global.activeConnection = { ...conn1, id: 'c1' };

    const recentUpdated = ctx.globalState.get(Constants.RecentConnectionsKey);
    assert.deepStrictEqual(recentUpdated, ['c1', 'c2']);
  });

  test('NodeDatabase setDefaultConnection and clearDefaultConnection update database default status', async function () {
    const saved = {
      c1: { ...conn1 },
      c2: { ...conn2 }
    };
    await ctx.globalState.update(Constants.ConectionsKey, saved);

    const fakeTreeProvider: any = {
      savedConnections: {},
      refresh() {}
    };

    const node1 = new NodeDatabase(conn1);
    await node1.setDefaultConnection(ctx, fakeTreeProvider);

    const connectionsAfter = ctx.globalState.get(Constants.ConectionsKey) as { [key: string]: ConnectionOptions };
    assert.strictEqual(connectionsAfter.c1.isDefault, true);
    assert.strictEqual(connectionsAfter.c2.isDefault, false);
    assert.strictEqual(fakeTreeProvider.savedConnections.c1.isDefault, true);

    // Clear default
    await node1.clearDefaultConnection(ctx, fakeTreeProvider);
    const connectionsAfterClear = ctx.globalState.get(Constants.ConectionsKey) as { [key: string]: ConnectionOptions };
    assert.strictEqual(connectionsAfterClear.c1.isDefault, false);
  });
});

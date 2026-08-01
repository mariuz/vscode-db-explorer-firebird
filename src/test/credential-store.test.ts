/**
 * CredentialStore's orphan reconciliation — see docs/roadmap/vscode-api-adoption.md.
 *
 * The gap this closes: passwords are stored per connection id and removed only when the delete
 * path runs, so a secret orphaned by a failed delete or a lost globalState entry stayed in
 * SecretStorage permanently, invisible to both the user and the extension. `secrets.keys()`
 * (VS Code 1.105) is what makes it auditable at all.
 */

import * as assert from 'assert';
import { CredentialStore } from '../shared/credential-store';

function fakeContext() {
  const store = new Map<string, string>();
  return {
    store,
    context: {
      secrets: {
        get: (k: string) => Promise.resolve(store.get(k)),
        store: (k: string, v: string) => { store.set(k, v); return Promise.resolve(); },
        delete: (k: string) => { store.delete(k); return Promise.resolve(); },
        keys: () => Promise.resolve([...store.keys()]),
      },
    } as any,
  };
}

suite('CredentialStore – stored connection ids', function () {
  test('reports database and SSH secrets separately, stripped of their key prefixes', async function () {
    const { context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storePassword('conn-a', 'pw');
    await CredentialStore.storeSshPassword('conn-b', 'ssh');

    const stored = await CredentialStore.listStoredConnectionIds();
    assert.deepStrictEqual(stored.passwords, ['conn-a']);
    assert.deepStrictEqual(stored.sshPasswords, ['conn-b']);
  });

  test('ignores keys belonging to anything else in SecretStorage', async function () {
    const { store, context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storePassword('conn-a', 'pw');
    store.set('some.other.extension.key', 'not ours');

    const stored = await CredentialStore.listStoredConnectionIds();
    assert.deepStrictEqual(stored.passwords, ['conn-a']);
    assert.deepStrictEqual(stored.sshPasswords, []);
  });
});

suite('CredentialStore – deleteOrphans()', function () {
  test('removes secrets whose connection is gone and keeps the rest', async function () {
    const { context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storePassword('live', 'pw');
    await CredentialStore.storePassword('deleted', 'pw');
    await CredentialStore.storeSshPassword('deleted', 'ssh');

    const removed = await CredentialStore.deleteOrphans(['live']);

    assert.strictEqual(removed, 2, 'both the database and SSH secret of the dead connection');
    assert.strictEqual(await CredentialStore.getPassword('live'), 'pw');
    assert.strictEqual(await CredentialStore.getPassword('deleted'), undefined);
    assert.strictEqual(await CredentialStore.getSshPassword('deleted'), undefined);
  });

  test('an SSH secret survives if its connection is still live, even with no database password', async function () {
    const { context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storeSshPassword('live', 'ssh');

    assert.strictEqual(await CredentialStore.deleteOrphans(['live']), 0);
    assert.strictEqual(await CredentialStore.getSshPassword('live'), 'ssh');
  });

  test('an empty live set clears everything — the "forget all passwords" case', async function () {
    const { context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storePassword('a', 'pw');
    await CredentialStore.storePassword('b', 'pw');

    assert.strictEqual(await CredentialStore.deleteOrphans([]), 2);
    assert.deepStrictEqual((await CredentialStore.listStoredConnectionIds()).passwords, []);
  });

  test('does nothing, and reports nothing, when there is nothing to clean', async function () {
    const { context } = fakeContext();
    CredentialStore.setContext(context);
    await CredentialStore.storePassword('live', 'pw');
    assert.strictEqual(await CredentialStore.deleteOrphans(['live']), 0);
  });
});

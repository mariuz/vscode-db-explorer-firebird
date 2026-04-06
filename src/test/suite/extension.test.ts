/**
 * Extension Development Host smoke tests.
 *
 * These tests run inside a real VS Code instance (the Extension Development
 * Host).  They verify that the extension activates correctly and exposes the
 * expected commands and tree-view contributions.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ninoDeme.vscode-db-explorer-firebird-fork';

suite('Extension Host – activation', function () {
  this.timeout(30000);

  let extension: vscode.Extension<unknown> | undefined;

  suiteSetup(async function () {
    extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension && !extension.isActive) {
      await extension.activate();
    }
  });

  test('extension is present', function () {
    assert.ok(extension, `Extension "${EXTENSION_ID}" should be installed in the test host`);
  });

  test('extension activates without error', function () {
    assert.ok(extension?.isActive, 'Extension should be active after activation');
  });
});

suite('Extension Host – commands', function () {
  this.timeout(10000);

  const expectedCommands = [
    'firebird.explorer.addConnection',
    'firebird.explorer.refresh',
    'firebird.explorer.newSqlDocument',
    'firebird.runQuery',
    'firebird.formatSql',
  ];

  test('registers all expected commands', async function () {
    const registered = await vscode.commands.getCommands(true);
    const registeredSet = new Set(registered);

    for (const cmd of expectedCommands) {
      assert.ok(registeredSet.has(cmd), `Expected command "${cmd}" to be registered`);
    }
  });
});

suite('Extension Host – workspace API sanity', function () {
  test('vscode API is available', function () {
    assert.ok(typeof vscode.version === 'string', 'vscode.version should be a string');
    assert.ok(vscode.version.length > 0, 'vscode.version should be non-empty');
  });

  test('can create and dispose a diagnostic collection', function () {
    const collection = vscode.languages.createDiagnosticCollection('firebird-test');
    assert.ok(collection, 'Should create a DiagnosticCollection');
    collection.dispose();
  });
});

/**
 * Extension Development Host smoke tests.
 *
 * These tests run inside a real VS Code instance (the Extension Development
 * Host).  They verify that the extension activates correctly and exposes the
 * expected commands and tree-view contributions.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';

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

/**
 * One command per docs/roadmap/*.md item, confirming each feature's entry point is actually wired
 * up (package.json's contributes.commands declaration + a matching commands.registerCommand() call
 * in extension.ts#activate() both present and consistent) in a real Extension Development Host —
 * the "registers all expected commands" suite above only ever checked five original commands, none
 * of them roadmap-feature-specific, so every roadmap item's command registration had actually never
 * been verified here at all before this. Grouped/commented by roadmap doc so a missing command
 * points straight at which feature broke.
 */
suite('Extension Host – roadmap feature commands', function () {
  this.timeout(10000);

  const roadmapCommands: Record<string, string[]> = {
    'connection-management-enhancements.md': ['firebird.database.copyConnectionString', 'firebird.database.editConnection', 'firebird.tasks.clearCompleted'],
    'cross-extension-connection-api.md': [
      'firebird.connectionSharing.listConnections', 'firebird.connectionSharing.getActiveConnection',
      'firebird.connectionSharing.runQuery', 'firebird.connectionSharing.runWriteQuery',
      'firebird.connectionSharing.editPermissions',
    ],
    'data-api-builder.md': ['firebird.database.generateDataApiSpec', 'firebird.database.generateDataApiSpecWithCopilot'],
    'database-projects.md': ['firebird.project.extract', 'firebird.project.build', 'firebird.project.publish'],
    'flat-file-import-wizard.md': ['firebird.database.importFlatFile'],
    'live-profiler.md': ['firebird.database.monitorDatabase'],
    'mcp-server.md': ['firebird.database.toggleMcpExposure', 'firebird.database.toggleMcpWriteAccess', 'firebird.mcp.showWriteAuditLog'],
    'query-plan-visualizer.md': ['firebird.showEstimatedPlan', 'firebird.explainPlan'],
    // First and last slot plus the bookmark binding — the loop that registers them is numeric, so
    // checking both ends catches an off-by-one in QUICK_QUERY_SLOT_COUNT as well as a broken loop.
    'quick-queries.md': ['firebird.quickQuery.1', 'firebird.quickQuery.9', 'firebird.bookmarks.assignSlot'],
    'schema-diff-migration-script.md': ['firebird.schemaDiff.generateMigrationScript'],
    'sql-notebooks.md': ['firebird.notebook.new'],
    'ssh-tunneling.md': ['firebird.database.setSshTunnelPassword'],
    'visual-schema-designer.md': ['firebird.schemaVisualizer.open', 'firebird.table.createTable', 'firebird.table.alterTable'],
  };

  test('every roadmap doc\'s key command(s) are actually registered', async function () {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing: string[] = [];

    for (const [doc, commands] of Object.entries(roadmapCommands)) {
      for (const cmd of commands) {
        if (!registered.has(cmd)) { missing.push(`${cmd} (${doc})`); }
      }
    }

    assert.deepStrictEqual(missing, [], `Missing command registration(s): ${missing.join(', ')}`);
  });
});

/**
 * The bottom-Panel host for query results (`firebird.queryResultsLocation`).
 *
 * This tier is where it can be checked at all: a `WebviewView` cannot be constructed by an
 * extension — VS Code builds it from the package.json contribution and calls the registered
 * provider — so nothing outside a real Extension Development Host can tell a working contribution
 * from a typo in a view id. The `.focus` command below is VS Code's own, auto-registered per
 * contributed view, and its existence is what proves the container and the view were accepted.
 */
suite('Extension Host – query results in the bottom Panel', function () {
  this.timeout(20000);

  test('the contributed Panel view exists, so VS Code accepted the container', async function () {
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.ok(
      registered.has('firebird.queryResultsPanel.focus'),
      'VS Code auto-registers <viewId>.focus for a contributed view — its absence means the view or its container was rejected'
    );
  });

  test('revealing the view resolves the provider without throwing', async function () {
    // The view is `when`-gated on the setting, so it has to be turned on for the reveal to reach
    // anything. Restored afterwards so the rest of the suite sees the shipped default.
    const config = vscode.workspace.getConfiguration('firebird');
    const previous = config.get('queryResultsLocation');
    await config.update('queryResultsLocation', 'panel', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('firebird.queryResultsPanel.focus');
    } finally {
      await config.update('queryResultsLocation', previous, vscode.ConfigurationTarget.Global);
    }
  });

  test('the setting still defaults to an editor group, so nobody is moved without asking', function () {
    const declared = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON
      ?.contributes?.configuration?.properties?.['firebird.queryResultsLocation'];
    assert.strictEqual(declared?.default, 'editor');
  });
});

suite('Extension Host – What\'s New notification', function () {
  test('extension still activates cleanly with the What\'s New check wired into activate()', function () {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension should still be active — a throw in showWhatsNewIfUpdated() must not break activation');
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

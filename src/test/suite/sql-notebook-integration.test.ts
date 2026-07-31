/**
 * Extension Development Host integration test for SQL Notebooks' phase 3 connection-binding
 * persistence (docs/roadmap/sql-notebooks.md): the connection a notebook is bound to is now
 * written into the .fbnb file's own metadata (FirebirdNotebookSerializer round-trips it, and
 * resolveNotebookConnection() checks it before ever prompting), so reopening a notebook (or a
 * VS Code restart) doesn't re-prompt for a connection the way it used to.
 *
 * Uses the real (unmocked) vscode Notebook API the Extension Development Host provides —
 * NotebookController/NotebookSerializer/NotebookCellExecution aren't mocked in
 * src/test/mocks/vscode.ts (see that roadmap doc's "Explicitly deferred" note), so this is the
 * only tier where this is meaningfully testable. Deliberately never drives window.showQuickPick
 * (it has no real UI to answer here and would hang the test) — every scenario below either
 * already has a persisted connectionId or has zero saved connections, both of which return before
 * the picker would ever open.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FirebirdNotebookSerializer } from '../../sql-notebook/serializer';
import { registerNotebookResultExport, serializeExport, NOTEBOOK_RENDERER_ID } from '../../sql-notebook/export';
import { FIREBIRD_NOTEBOOK_TYPE, resolveNotebookConnection, resultToOutputItems, RESULT_TABLE_MIME } from '../../sql-notebook/controller';
import { Constants } from '../../config';
import { getTestConnectionOptions } from './firebird-test-env';

const CancellationToken = new vscode.CancellationTokenSource().token;
const EXTENSION_ID = 'AdrianMariusPopa.vscode-firebird-studio';

suite('SQL Notebooks – connection-binding persistence (extension host)', function () {
  this.timeout(10000);

  suiteSetup(async function () {
    // Registering FIREBIRD_NOTEBOOK_TYPE happens in activate() — make sure it's actually run
    // before openNotebookDocument() below relies on that contributed type existing.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension && !extension.isActive) {
      await extension.activate();
    }
  });

  suite('FirebirdNotebookSerializer', function () {
    const serializer = new FirebirdNotebookSerializer();

    test('round-trips a persisted connectionId through serialize -> deserialize', function () {
      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1 FROM RDB$DATABASE', 'sql');
      const data = new vscode.NotebookData([cell]);
      data.metadata = { connectionId: 'my-saved-connection-id' };

      const bytes = serializer.serializeNotebook(data, CancellationToken);
      const onDisk = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert.strictEqual(onDisk.metadata?.connectionId, 'my-saved-connection-id', 'connectionId should be written to the on-disk JSON');

      const roundTripped = serializer.deserializeNotebook(bytes, CancellationToken);
      assert.strictEqual(roundTripped.metadata?.connectionId, 'my-saved-connection-id', 'connectionId should survive a full serialize/deserialize round trip');
    });

    test('a notebook with no bound connection serializes without a metadata.connectionId key', function () {
      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1 FROM RDB$DATABASE', 'sql');
      const data = new vscode.NotebookData([cell]);

      const bytes = serializer.serializeNotebook(data, CancellationToken);
      const onDisk = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert.strictEqual(onDisk.metadata, undefined, 'no metadata.connectionId should mean no metadata key at all in the file');
    });

    test('an empty/new notebook still opens with one blank SQL cell (unaffected by the metadata change)', function () {
      const data = serializer.deserializeNotebook(new Uint8Array(), CancellationToken);
      assert.strictEqual(data.cells.length, 1);
      assert.strictEqual(data.cells[0].languageId, 'sql');
      assert.strictEqual(data.cells[0].value, '');
    });
  });

  suite('resolveNotebookConnection()', function () {
    test('uses the persisted connectionId without prompting, when that connection still exists', async function () {
      const connectionOptions = { ...getTestConnectionOptions(), password: 'seeded-password' };
      const store = new Map<string, unknown>();
      store.set(Constants.ConectionsKey, { [connectionOptions.id]: connectionOptions });
      const fakeContext = {
        globalState: { get: (key: string, dflt?: unknown) => store.has(key) ? store.get(key) : dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const initialData = new vscode.NotebookData([cell]);
      initialData.metadata = { connectionId: connectionOptions.id };
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, initialData);

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.ok(resolved, 'expected a resolved connection from the persisted id, no prompt needed');
      assert.strictEqual(resolved!.id, connectionOptions.id);
      assert.strictEqual(resolved!.password, 'seeded-password');
    });

    test('returns undefined without prompting when there is no persisted id and no saved connections at all', async function () {
      const fakeContext = {
        globalState: { get: (_key: string, dflt?: unknown) => dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, new vscode.NotebookData([cell]));

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.strictEqual(resolved, undefined);
    });

    test('falls through past a stale persisted id (connection since removed) to "no connections" rather than reusing a nonexistent one', async function () {
      const fakeContext = {
        globalState: { get: (_key: string, dflt?: unknown) => dflt },
      } as unknown as vscode.ExtensionContext;

      const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'sql');
      const initialData = new vscode.NotebookData([cell]);
      initialData.metadata = { connectionId: 'a-connection-id-that-no-longer-exists' };
      const notebook = await vscode.workspace.openNotebookDocument(FIREBIRD_NOTEBOOK_TYPE, initialData);

      const resolved = await resolveNotebookConnection(notebook, fakeContext);
      assert.strictEqual(resolved, undefined, 'a stale id with zero saved connections should resolve to undefined, not throw or hang');
    });
  });

  suite('resultToOutputItems() (phase 2 — custom rich-results renderer)', function () {
    async function itemText(item: vscode.NotebookCellOutputItem): Promise<string> {
      return Buffer.from(item.data).toString('utf8');
    }

    test('a row-bearing result gets the rich JSON mime first, then a markdown fallback', async function () {
      const items = resultToOutputItems({
        sql: 'select * from x', durationMs: 1,
        rows: [{ ID: 1, NAME: 'Alice' }, { ID: 2, NAME: null }],
      });
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items[0].mime, RESULT_TABLE_MIME);
      assert.strictEqual(items[1].mime, 'text/markdown');

      const table = JSON.parse(await itemText(items[0]));
      assert.deepStrictEqual(table.headers, ['ID', 'NAME']);
      assert.deepStrictEqual(table.rows, [['1', 'Alice'], ['2', null]]);
      assert.strictEqual(table.truncated, false);
      assert.strictEqual(table.totalRowCount, 2);

      const markdown = await itemText(items[1]);
      assert.ok(markdown.includes('| ID | NAME |'), markdown);
      assert.ok(markdown.includes('| 1 | Alice |'), markdown);
    });

    test('an empty (0-row) SELECT still produces both output items, not the plain-message branch', async function () {
      const items = resultToOutputItems({ sql: 'select * from x where 1=0', durationMs: 1, rows: [] });
      assert.strictEqual(items.length, 2);
      const table = JSON.parse(await itemText(items[0]));
      assert.deepStrictEqual(table, { headers: [], rows: [], truncated: false, totalRowCount: 0 });
    });

    test('an error result produces a single error output item, no rich/markdown items', async function () {
      const items = resultToOutputItems({ sql: 'bad sql', durationMs: 1, error: 'table not found' });
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].mime, 'application/vnd.code.notebook.error');
      const parsed = JSON.parse(await itemText(items[0]));
      assert.strictEqual(parsed.message, 'table not found');
    });

    test('a DDL/DML result with no rows produces a single plain-text message item, no rich/markdown items', async function () {
      const items = resultToOutputItems({ sql: 'create table t (id int)', durationMs: 1, message: 'Statement executed successfully.' });
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].mime, 'text/plain');
      assert.strictEqual(await itemText(items[0]), 'Statement executed successfully.');
    });
  });
});

suite('SQL Notebook result export – renderer messaging (extension host)', function () {
  this.timeout(20000);

  test('the messaging channel registers against the same renderer id package.json contributes', function () {
    // A mismatch between the id in export.ts and the contributed notebookRenderer id is silent:
    // the channel would simply never receive a message, and the Export button would do nothing.
    const extension = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    assert.ok(extension, 'extension should be found by id');
    const contributed = extension!.packageJSON.contributes.notebookRenderer as { id: string; requiresMessaging?: string }[];
    const renderer = contributed.find(r => r.id === NOTEBOOK_RENDERER_ID);
    assert.ok(renderer, `no contributed notebookRenderer with id ${NOTEBOOK_RENDERER_ID}`);
    assert.strictEqual(renderer!.requiresMessaging, 'optional', 'messaging must be declared or postMessage never reaches the host');
  });

  test('registering the export channel twice does not throw (activation is idempotent for tests)', function () {
    const first = registerNotebookResultExport();
    const second = registerNotebookResultExport();
    first.dispose();
    second.dispose();
  });

  test('serializeExport() produces the file contents for both formats', function () {
    const message = {
      type: 'exportResult' as const,
      headers: ['ID', 'NAME'],
      rows: [['1', 'Widget, A'], ['2', null]] as (string | null)[][],
    };
    assert.strictEqual(serializeExport(message, 'csv'), 'ID,NAME\n1,"Widget, A"\n2,');
    assert.deepStrictEqual(JSON.parse(serializeExport(message, 'json')), [
      { ID: '1', NAME: 'Widget, A' },
      { ID: '2', NAME: null },
    ]);
  });
});

import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Language Model Tools (docs/roadmap/language-model-tools.md, phases 2-3) — verified in a real
 * Extension Development Host, because that's the only tier where `vscode.lm` exists at all
 * (`src/test/mocks/vscode.ts` doesn't stub it, and the tool bodies themselves are already covered
 * without any VS Code API by `src/test/db-tools.test.ts` against a fake `ToolExecutor`).
 *
 * What's genuinely only checkable here: that the `contributes.languageModelTools` manifest entries
 * and the `vscode.lm.registerTool()` calls agree on tool names — a mismatch between the two is
 * silent, and would leave a contributed tool permanently unimplemented.
 */

const EXPECTED_TOOLS = [
  'firebird_listConnections',
  'firebird_getSchema',
  'firebird_runQuery',
  'firebird_getQueryPlan',
  'firebird_runWriteQuery',
];

suite('Language Model Tools – registration (extension host)', function () {
  this.timeout(20000);

  suiteSetup(async function () {
    const extension = vscode.extensions.getExtension('AdrianMariusPopa.vscode-firebird-studio');
    assert.ok(extension, 'extension should be found by id');
    await extension!.activate();
  });

  test('every contributed language model tool is actually registered under the same name', function () {
    if (typeof vscode.lm === 'undefined') {
      this.skip();
    }
    const available = new Set(vscode.lm.tools.map(tool => tool.name));
    const missing = EXPECTED_TOOLS.filter(name => !available.has(name));
    assert.deepStrictEqual(missing, [], `contributed but not registered: ${missing.join(', ')}`);
  });

  test('each registered tool carries a model-facing description', function () {
    if (typeof vscode.lm === 'undefined') {
      this.skip();
    }
    for (const name of EXPECTED_TOOLS) {
      const tool = vscode.lm.tools.find(t => t.name === name);
      assert.ok(tool, `${name} should be registered`);
      assert.ok((tool!.description ?? '').length > 0, `${name} should have a description for the model`);
    }
  });

  test('firebird_listConnections is invokable and returns JSON, whatever this host happens to have saved', async function () {
    if (typeof vscode.lm === 'undefined' || typeof vscode.lm.invokeTool !== 'function') {
      this.skip();
    }
    const result = await vscode.lm.invokeTool('firebird_listConnections', {
      input: {},
      toolInvocationToken: undefined,
    });
    const text = result.content
      .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
      .map(part => part.value)
      .join('');
    assert.ok(Array.isArray(JSON.parse(text)), `expected a JSON array, got: ${text.slice(0, 200)}`);
  });

  test('the write tool refuses an unknown connection id before touching any database', async function () {
    if (typeof vscode.lm === 'undefined' || typeof vscode.lm.invokeTool !== 'function') {
      this.skip();
    }
    // Deliberately an id that cannot resolve: this exercises the real registered tool and its
    // shared gate end-to-end in the host without a database, a write, or a confirmation prompt.
    const result = await vscode.lm.invokeTool('firebird_runWriteQuery', {
      input: { connectionId: 'definitely-not-a-real-connection', sql: 'DELETE FROM PRODUCTS' },
      toolInvocationToken: undefined,
    });
    const text = result.content
      .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
      .map(part => part.value)
      .join('');
    assert.ok(text.includes('list_connections'), text);
  });
});

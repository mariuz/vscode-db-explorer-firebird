import * as assert from 'assert';
import ResultView from '../result-view';

suite('Edit Data & Global Search Integration', function () {
  test('ResultView displayEditable sets autoEdit to true in sent message', async function () {
    const sentMessages: any[] = [];

    // Create instance of ResultView with mocked panel/webview
    const resultView = new (class extends ResultView {
      constructor() {
        super(__dirname);
      }
      // Override send to capture payload
      protected send(msg: any) {
        sentMessages.push(msg);
      }
      // Override show to avoid loading actual html file
      protected show() {}
    })();

    // Call displayEditable
    resultView.displayEditable(
      [{ ID: 1, NAME: 'Alice' }],
      '100',
      'CUSTOMERS',
      { sql: 'SELECT * FROM CUSTOMERS', probedForMore: false }
    );

    await (resultView as any).sendData();

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].command, 'message');
    assert.strictEqual(sentMessages[0].data.editableTable, 'CUSTOMERS');
    assert.strictEqual(sentMessages[0].data.autoEdit, true);

    // Call normal display to verify autoEdit resets to false
    sentMessages.length = 0;
    resultView.display(
      [{ ID: 1, NAME: 'Alice' }],
      '100',
      'CUSTOMERS'
    );

    await (resultView as any).sendData();

    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].command, 'message');
    assert.strictEqual(sentMessages[0].data.autoEdit, false);
  });
});

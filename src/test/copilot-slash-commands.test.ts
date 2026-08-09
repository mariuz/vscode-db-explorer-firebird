import * as assert from 'assert';
import {
  buildConnectMessages,
  buildSchemaPromptMessages,
  buildMockMessages,
  buildExplainMessages,
  buildOptimizeMessages,
} from '../copilot/prompts';

suite('Copilot Slash Commands Prompt Builders', function () {
  test('buildConnectMessages includes target database and schema block', function () {
    const messages = buildConnectMessages('EMPLOYEE.FDB', 'TABLE CUSTOMERS (ID INT)');
    assert.strictEqual(messages.length, 2);
    const content = messages[1].content;
    assert.ok(content.includes('EMPLOYEE.FDB'), content);
  });

  test('buildSchemaPromptMessages creates table DDL and ER request', function () {
    const messages = buildSchemaPromptMessages('ORDERS', 'TABLE ORDERS (ID INT)');
    assert.strictEqual(messages.length, 2);
    const content = messages[1].content;
    assert.ok(content.includes('ORDERS'), content);
    assert.ok(content.includes('DDL definition'), content);
  });

  test('buildMockMessages creates mock data insert script request', function () {
    const messages = buildMockMessages('PRODUCTS', 'TABLE PRODUCTS (ID INT, NAME VARCHAR(50))');
    assert.strictEqual(messages.length, 2);
    const content = messages[1].content;
    assert.ok(content.includes('PRODUCTS'), content);
    assert.ok(content.includes('INSERT INTO'), content);
  });

  test('buildExplainMessages handles query explanation', function () {
    const messages = buildExplainMessages('SELECT * FROM CUSTOMERS', '');
    assert.strictEqual(messages.length, 2);
    assert.ok(messages[1].content.includes('SELECT * FROM CUSTOMERS'));
  });

  test('buildOptimizeMessages handles query optimization', function () {
    const messages = buildOptimizeMessages('SELECT * FROM CUSTOMERS WHERE ID = 1', '');
    assert.strictEqual(messages.length, 2);
    assert.ok(messages[1].content.includes('SELECT * FROM CUSTOMERS WHERE ID = 1'));
  });
});

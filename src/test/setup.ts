/**
 * Test setup: register the vscode mock so that `require('vscode')` resolves to
 * our minimal stub when tests run outside the VS Code extension host.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'vscode') {
    // Return the compiled mock (ts-node compiles on the fly)
    return require(path.join(__dirname, 'mocks', 'vscode'));
  }
  // eslint-disable-next-line prefer-rest-params
  return originalLoad.apply(this, arguments);
};

//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';
import { splitStatements } from '../shared/sql-splitter';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
// import * as vscode from 'vscode';
// import * as myExtension from '../extension';

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", function () {

    // Defines a Mocha unit test
    test("Something 1", function() {
        assert.equal(-1, [1, 2, 3].indexOf(5));
        assert.equal(-1, [1, 2, 3].indexOf(0));
    });
});

suite("SQL Splitter", function () {
    test("splits two statements separated by semicolons", function () {
        const result = splitStatements("SELECT 1 FROM RDB$DATABASE; SELECT 2 FROM RDB$DATABASE;");
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0], "SELECT 1 FROM RDB$DATABASE");
        assert.strictEqual(result[1], "SELECT 2 FROM RDB$DATABASE");
    });

    test("handles a single statement without trailing semicolon", function () {
        const result = splitStatements("SELECT * FROM CUSTOMERS");
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0], "SELECT * FROM CUSTOMERS");
    });

    test("ignores semicolons inside single-quoted strings", function () {
        const result = splitStatements("SELECT 'a;b' FROM T; SELECT 2 FROM T");
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0], "SELECT 'a;b' FROM T");
    });

    test("ignores semicolons inside line comments", function () {
        const result = splitStatements("-- comment; still same\nSELECT 1 FROM RDB$DATABASE");
        assert.strictEqual(result.length, 1);
    });

    test("ignores semicolons inside block comments", function () {
        const result = splitStatements("/* a; b */ SELECT 1 FROM RDB$DATABASE");
        assert.strictEqual(result.length, 1);
    });

    test("returns empty array for whitespace-only input", function () {
        assert.deepStrictEqual(splitStatements("   \n\t  "), []);
    });

    test("filters out empty statements (double semicolons)", function () {
        const result = splitStatements("SELECT 1 FROM RDB$DATABASE;; SELECT 2 FROM RDB$DATABASE");
        assert.strictEqual(result.length, 2);
    });

    test("handles escaped single quotes inside strings", function () {
        const result = splitStatements("SELECT 'it''s' FROM T; SELECT 2 FROM T");
        assert.strictEqual(result.length, 2);
        assert.strictEqual(result[0], "SELECT 'it''s' FROM T");
    });
});

suite("Schema Context Builder", function () {
    // Import inline to avoid pulling in vscode module in pure-node test runner
    const { buildSchemaContext } = require('../copilot/schema-context');

    test("returns empty string for undefined schema", function () {
        assert.strictEqual(buildSchemaContext(undefined), '');
    });

    test("returns empty string for schema with no tables", function () {
        assert.strictEqual(buildSchemaContext({ reservedKeywords: true, tables: [] }), '');
    });

    test("formats single table with typed fields", function () {
        const schema = {
            reservedKeywords: true,
            tables: [
                {
                    name: 'CUSTOMERS',
                    fields: [
                        { name: 'ID', type: 'INTEGER' },
                        { name: 'NAME', type: 'VARCHAR(50)' },
                    ],
                },
            ],
        };
        assert.strictEqual(buildSchemaContext(schema), 'CUSTOMERS(ID INTEGER, NAME VARCHAR(50))');
    });

    test("formats multiple tables on separate lines", function () {
        const schema = {
            reservedKeywords: true,
            tables: [
                { name: 'A', fields: [{ name: 'X', type: 'INTEGER' }] },
                { name: 'B', fields: [{ name: 'Y', type: 'VARCHAR(10)' }] },
            ],
        };
        const result = buildSchemaContext(schema);
        const lines = result.split('\n');
        assert.strictEqual(lines.length, 2);
        assert.strictEqual(lines[0], 'A(X INTEGER)');
        assert.strictEqual(lines[1], 'B(Y VARCHAR(10))');
    });

    test("handles fields without type", function () {
        const schema = {
            reservedKeywords: false,
            tables: [
                { name: 'T', fields: [{ name: 'COL1' }] },
            ],
        };
        assert.strictEqual(buildSchemaContext(schema), 'T(COL1)');
    });

    test("handles table with no fields", function () {
        const schema = {
            reservedKeywords: true,
            tables: [
                { name: 'EMPTY_TBL', fields: [] },
            ],
        };
        assert.strictEqual(buildSchemaContext(schema), 'EMPTY_TBL()');
    });
});
import * as assert from "assert";
import { describeEmptyBatch, splitStatementsWithOffsets } from "../shared/sql-splitter";

/**
 * Running an empty editor used to end at runBatch()'s throw, which the command's catch reported as
 * "Oops! Something went wrong. Check the log output for more details!" -- a message describing a
 * crash, offering a log with nothing in it, for the entirely ordinary case of having written no
 * SQL yet. mssql closed the same gap in #22682.
 */
suite("describeEmptyBatch()", function () {
  test("an empty document says so", function () {
    assert.strictEqual(describeEmptyBatch("", "document"), "Nothing to run — this file is empty.");
    assert.strictEqual(describeEmptyBatch("   \n\t ", "document"), "Nothing to run — this file is empty.");
  });

  test("an empty selection is named as a selection, not as the file", function () {
    assert.strictEqual(describeEmptyBatch("  ", "selection"), "Nothing to run — the selection is empty.");
  });

  test("a notebook cell is named as a cell", function () {
    assert.strictEqual(describeEmptyBatch("", "cell"), "Nothing to run — this cell is empty.");
  });

  test("defaults to describing a document", function () {
    assert.strictEqual(describeEmptyBatch(""), describeEmptyBatch("", "document"));
  });

  // The case worth distinguishing: the splitter drops comments, so by statement count alone a file
  // of nothing but `--` lines looks identical to an empty one -- while to the person looking at it
  // the file is obviously not empty, and "this file is empty" would read as a bug.
  test("a comment-only file says it is comments, not that it is empty", function () {
    assert.strictEqual(
      describeEmptyBatch("-- TODO: write the query\n-- then run it\n", "document"),
      "Nothing to run — this file contains only comments."
    );
    assert.strictEqual(
      describeEmptyBatch("/* nothing here yet */", "document"),
      "Nothing to run — this file contains only comments."
    );
    assert.strictEqual(
      describeEmptyBatch("-- line\n/* block */\n", "document"),
      "Nothing to run — this file contains only comments."
    );
  });

  test("bare semicolons are called out on their own", function () {
    assert.strictEqual(
      describeEmptyBatch(";;;", "document"),
      "Nothing to run — this file contains no statements, only semicolons."
    );
    assert.strictEqual(
      describeEmptyBatch("-- c\n;\n", "document"),
      "Nothing to run — this file contains no statements, only semicolons."
    );
  });

  test("anything else falls back to a truthful, non-specific answer", function () {
    assert.strictEqual(
      describeEmptyBatch("SELECT", "document"),
      "Nothing to run — no complete SQL statement was found in this file."
    );
  });

  // The description is only ever shown when the splitter produced nothing, so the two have to
  // agree about what "nothing" is -- a message claiming a file is empty while a statement runs
  // would be worse than the generic error it replaced.
  test("every text it describes really does split to zero statements", function () {
    for (const text of ["", "   ", "\n\n", "-- c", "/* b */", ";", ";;;", "-- c\n;\n", "/* a */ -- b\n"]) {
      assert.strictEqual(
        splitStatementsWithOffsets(text).length, 0,
        `${JSON.stringify(text)} should split to zero statements`
      );
      assert.ok(describeEmptyBatch(text).startsWith("Nothing to run — "), text);
    }
  });

  test("text that does split to a statement is never described as empty by the caller", function () {
    // Guards the inverse: these reach the normal path, so their description is never shown.
    for (const text of ["SELECT 1;", "-- c\nSELECT 1;", "/* b */ SELECT 1"]) {
      assert.ok(splitStatementsWithOffsets(text).length > 0, text);
    }
  });
});

/**
 * There are **two** empty guards, and the first pass only fixed the second one.
 *
 * `runBatch()`'s post-split guard fires when text was present but produced no statements
 * (comments, bare semicolons). An *entirely* empty document never reaches it — it is caught
 * earlier, by the `if (!sql)` check in `resolveSqlAndConnection()` — so the commonest case of all
 * still reported "Oops! Something went wrong. Check the log output for more details!" after the
 * change that was supposed to remove exactly that message. Both guards now carry the same marker.
 */
suite("Both empty guards report the same way", function () {
  const { Driver } = require("../shared/driver");
  const vscode = require("./mocks/vscode");

  const conn = { id: "x", host: "h", port: 3050, database: "d", user: "u", password: "p", role: null };
  let previousClient: any, previousEditor: any;

  setup(function () {
    previousClient = Driver.client;
    previousEditor = vscode.window.activeTextEditor;
    Driver.client = { createConnection: async () => ({}), detach: async () => { }, queryPromise: async () => [] };
    vscode.window.activeTextEditor = {
      selection: { isEmpty: true },
      document: {
        languageId: "sql", getText: () => "", uri: { toString: () => "f" },
        positionAt: () => ({ line: 0, character: 0 }), offsetAt: () => 0, lineCount: 1,
      },
    };
  });

  teardown(function () {
    Driver.client = previousClient;
    vscode.window.activeTextEditor = previousEditor;
  });

  test("an entirely empty document is marked empty by runBatch, not reported as a failure", async function () {
    await assert.rejects(Driver.runBatch(undefined, conn), (err: any) => {
      assert.strictEqual(err.empty, true, "the pre-split guard must carry the same marker as the post-split one");
      assert.match(err.message, /^Nothing to run — /);
      return true;
    });
  });

  test("runQuery's own guard reports it the same way", async function () {
    await assert.rejects(Driver.runQuery(undefined, conn), (err: any) => {
      assert.strictEqual(err.empty, true);
      assert.match(err.message, /^Nothing to run — /);
      return true;
    });
  });
});

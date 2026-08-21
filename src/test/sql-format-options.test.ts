import * as assert from "assert";
import { formatSQL } from "../shared/sql-formatter";
import {
  indentFromEditor, resolveKeywordCase, buildFormatOptions
} from "../language-server/format-model";

/**
 * The formatter took no options at all until it became a real formatting provider. These cover the
 * two knobs that adds -- keyword casing, and an indent that comes from the editor rather than from
 * a second setting of our own -- plus the guarantee that calling it with no options at all still
 * does exactly what it did before, which is what the 19 tests in sql-formatter.test.ts pin.
 */
suite("formatSQL() – options", function () {
  suite("keywordCase", function () {
    test("defaults to upper, unchanged from before options existed", function () {
      assert.strictEqual(formatSQL("select a from t"), formatSQL("select a from t", { keywordCase: "upper" }));
      assert.ok(formatSQL("select a from t").startsWith("SELECT"));
    });

    test("lower cases every recognised keyword down", function () {
      const out = formatSQL("SELECT A FROM T WHERE A = 1", { keywordCase: "lower" });
      assert.ok(out.includes("select"), out);
      assert.ok(out.includes("from"), out);
      assert.ok(out.includes("where"), out);
      assert.ok(!/\bSELECT\b/.test(out), out);
      assert.ok(!/\bWHERE\b/.test(out), out);
    });

    test("lower leaves identifiers alone -- it cases keywords, not everything", function () {
      const out = formatSQL("SELECT CustomerName FROM Customers", { keywordCase: "lower" });
      assert.ok(out.includes("CustomerName"), out);
      assert.ok(out.includes("Customers"), out);
    });

    // The layout pass rewrites SELECT/FROM itself, so preserve has to survive that too -- it was
    // re-emitting both from string literals and quietly uppercasing them.
    test("preserve leaves the author's own casing exactly as typed", function () {
      const out = formatSQL("select a, b from t where a = 1", { keywordCase: "preserve" });
      assert.ok(out.includes("select"), out);
      assert.ok(out.includes("from"), out);
      assert.ok(out.includes("where"), out);
      assert.ok(!/\bSELECT\b/.test(out), `SELECT was uppercased under preserve: ${out}`);
      assert.ok(!/\bFROM\b/.test(out), `FROM was uppercased under preserve: ${out}`);
    });

    test("preserve keeps mixed casing rather than normalising it", function () {
      const out = formatSQL("Select a From t", { keywordCase: "preserve" });
      assert.ok(out.includes("Select"), out);
      assert.ok(out.includes("From"), out);
    });

    test("preserve still applies layout -- it is a casing option, not an off switch", function () {
      const out = formatSQL("select a from t where a = 1", { keywordCase: "preserve" });
      assert.ok(out.split("\n").length >= 3, `layout was not applied: ${JSON.stringify(out)}`);
    });

    test("string literals are untouched whatever the casing option", function () {
      for (const keywordCase of ["upper", "lower", "preserve"] as const) {
        const out = formatSQL("select 'From Select Where' from t", { keywordCase });
        assert.ok(out.includes("'From Select Where'"), `${keywordCase}: ${out}`);
      }
    });
  });

  suite("indent", function () {
    test("defaults to the four spaces this formatter always used", function () {
      const out = formatSQL("select a, b from t");
      assert.ok(out.includes("\n    a,"), JSON.stringify(out));
    });

    test("a two-space indent is honoured", function () {
      const out = formatSQL("select a, b from t", { indent: "  " });
      assert.ok(out.includes("\n  a,"), JSON.stringify(out));
      assert.ok(!out.includes("\n    a,"), JSON.stringify(out));
    });

    test("a tab indent is honoured", function () {
      const out = formatSQL("select a, b from t", { indent: "\t" });
      assert.ok(out.includes("\n\ta,"), JSON.stringify(out));
    });
  });
});

suite("Formatting provider – indentFromEditor()", function () {
  test("spaces produce that many spaces", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 2, insertSpaces: true }), "  ");
    assert.strictEqual(indentFromEditor({ tabSize: 8, insertSpaces: true }), "        ");
  });

  test("tabs produce one tab, whatever tabSize claims -- a tab's width is a rendering choice", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 4, insertSpaces: false }), "\t");
    assert.strictEqual(indentFromEditor({ tabSize: 8, insertSpaces: false }), "\t");
  });

  test("a nonsense tab size falls back to four rather than producing no indent at all", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 0, insertSpaces: true }), "    ");
    assert.strictEqual(indentFromEditor({ tabSize: -2, insertSpaces: true }), "    ");
    assert.strictEqual(indentFromEditor({ tabSize: NaN, insertSpaces: true }), "    ");
  });

  test("a fractional tab size is floored, not passed to repeat() to throw", function () {
    assert.strictEqual(indentFromEditor({ tabSize: 2.7, insertSpaces: true }), "  ");
  });
});

suite("Formatting provider – resolveKeywordCase()", function () {
  test("accepts the three documented values", function () {
    assert.strictEqual(resolveKeywordCase("upper"), "upper");
    assert.strictEqual(resolveKeywordCase("lower"), "lower");
    assert.strictEqual(resolveKeywordCase("preserve"), "preserve");
  });

  test("anything else falls back to the manifest default rather than reaching the formatter", function () {
    // A settings value can be anything at all -- it comes from a JSON file the user edits.
    assert.strictEqual(resolveKeywordCase("UPPER"), "upper");
    assert.strictEqual(resolveKeywordCase("shouty"), "upper");
    assert.strictEqual(resolveKeywordCase(undefined), "upper");
    assert.strictEqual(resolveKeywordCase(null), "upper");
    assert.strictEqual(resolveKeywordCase(42), "upper");
  });
});

suite("Formatting provider – buildFormatOptions()", function () {
  test("combines the editor's indentation with the user's casing setting", function () {
    assert.deepStrictEqual(
      buildFormatOptions({ tabSize: 2, insertSpaces: true }, "lower"),
      { indent: "  ", keywordCase: "lower" }
    );
  });

  test("survives a garbage setting without losing the editor's indentation", function () {
    assert.deepStrictEqual(
      buildFormatOptions({ tabSize: 4, insertSpaces: false }, {}),
      { indent: "\t", keywordCase: "upper" }
    );
  });

  test("what it returns actually drives formatSQL", function () {
    const out = formatSQL("select a, b from t", buildFormatOptions({ tabSize: 2, insertSpaces: true }, "lower"));
    assert.ok(out.startsWith("select"), out);
    assert.ok(out.includes("\n  a,"), JSON.stringify(out));
  });
});

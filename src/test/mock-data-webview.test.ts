/**
 * Unit coverage for the Mock Data webview's form scripts.
 *
 * These three files were the last webview code in the repository that no test had ever executed —
 * 0% across all three tiers, which is what the merged coverage report added in
 * docs/roadmap/webview-ui-testing.md phase 4 exists to surface. Unlike the other webviews there is
 * no Playwright spec to pair with this: the Mock Data panel never opens without a Mockaroo API key
 * (`NodeTable.generateMockData()` refuses before creating the webview), so a spec would need a live
 * third-party account to get as far as rendering.
 *
 * What is worth pinning here is the *coupling between the files*, since nothing else checks it: the
 * form is built from `dataTypes()` in formOptions.js, wired per row by `initAutoComplete(index)` in
 * app.js against element ids that formOptions.js generates, and validated by `checkForm()` in
 * formHelpers.js against that same list. Each of those joins fails silently.
 */

import * as assert from "assert";
import * as path from "path";
import { installWebviewStubs, loadWebviewModule } from "./webview-harness";

const MOCK_DATA_JS = path.join(__dirname, "..", "..", "src", "mock-data", "htmlContent", "js");

suite("mock-data webview – form options", function () {
  let options: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    options = loadWebviewModule(path.join(MOCK_DATA_JS, "formOptions.js")).__test__;
  });
  suiteTeardown(function () { restore(); });

  test("offers a substantial list of Mockaroo types", function () {
    assert.ok(options.dataTypes(0).length > 50, `only ${options.dataTypes(0).length} types`);
  });

  test("every type has a unique value", function () {
    // The value is the autocomplete's key *and* what checkForm() validates against; a duplicate
    // silently shadows an entry, so one of the two types becomes unreachable in the form.
    const values = options.dataTypes(0).map((t: any) => t.value);
    const duplicates = values.filter((v: string, i: number) => values.indexOf(v) !== i);
    assert.deepStrictEqual(duplicates, [], `duplicate type values: ${duplicates.join(", ")}`);
  });

  test("every type carries the fields the autocomplete renders", function () {
    // `groupBy: "category"` in app.js means a type with no category lands in an unnamed group
    // rather than failing, and a missing description renders as "undefined" in the panel.
    for (const type of options.dataTypes(0)) {
      assert.ok(type.data, `${type.value} has no data`);
      assert.ok(type.data.category, `${type.value} has no category`);
      assert.ok(type.data.shortDesc, `${type.value} has no short description`);
      assert.ok(type.data.longDesc, `${type.value} has no long description`);
    }
  });

  test("a type's options HTML is scoped to the row it belongs to", function () {
    // Options are injected per table row (each builder returns an array of HTML fragments). If a
    // builder ignored its id, two rows would render elements with the same id and editing one
    // would silently read the other's value.
    const withOptions = options.dataTypes(7).filter((t: any) => t.data.options);
    assert.ok(withOptions.length > 0, "expected at least one type with configurable options");
    for (const type of withOptions) {
      const html = [].concat(type.data.options).join("");
      assert.ok(
        html.includes("7"),
        `${type.value}'s options do not mention the row id: ${html.slice(0, 120)}`
      );
    }
  });

  test("a type without options says so with `false`, not an empty string", function () {
    // app.js's setDataTypeOptions() branches on this being falsy; an empty string would work by
    // accident, but `false` is what the code reads as "this type takes no configuration".
    const plain = options.dataTypes(0).filter((t: any) => !t.data.options);
    assert.ok(plain.length > 0);
    for (const type of plain) {
      assert.strictEqual(type.data.options, false, `${type.value} uses ${JSON.stringify(type.data.options)}`);
    }
  });

  suite("nullOptions()", function () {
    test("a NOT NULL column cannot be given a null percentage", function () {
      // Mockaroo would happily generate nulls for a NOT NULL column and the INSERT would fail on
      // the server; disabling the input is what prevents it.
      assert.ok(options.nullOptions(2, true).includes("disabled"));
    });

    test("a nullable column can", function () {
      assert.ok(!options.nullOptions(2, false).includes("disabled"));
    });

    test("its input is named percentBlank, which is what Mockaroo expects", function () {
      // parseForm() collects inputs by `name`, and the name is sent straight to the API.
      assert.ok(options.nullOptions(2, false).includes('name="percentBlank"'));
    });

    test("its ids are row-scoped", function () {
      assert.ok(options.nullOptions(5, false).includes("nullOption_5"));
      assert.ok(options.nullOptions(5, false).includes("nullDescription_5"));
    });
  });

  suite("mockSearchInput()", function () {
    test("generates the id app.js's initAutoComplete() looks for", function () {
      // This is a cross-file contract with no other check: app.js calls
      // `$(\`#autocomplete_${index}\`).autocomplete(...)`, so if this id changed, every row's type
      // picker would quietly stop working while the panel still rendered.
      assert.ok(options.mockSearchInput(4).includes('id="autocomplete_4"'));
      assert.ok(options.mockSearchInput(4).includes('id="mockDescription_4"'));
    });

    test("the field is required and carries the class validateForm() scans", function () {
      // validateForm() iterates `.biginput`; without the class it would find nothing and treat an
      // empty form as valid.
      assert.ok(options.mockSearchInput(0).includes("biginput"));
      assert.ok(options.mockSearchInput(0).includes("required"));
    });
  });
});

suite("mock-data webview – form validation", function () {
  let helpers: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    const options = loadWebviewModule(path.join(MOCK_DATA_JS, "formOptions.js")).__test__;
    // In the browser both files are plain <script>s sharing the global scope; under require() they
    // are separate modules, so checkForm()'s reference to `dataTypes` has to be supplied.
    (global as any).dataTypes = options.dataTypes;
    helpers = loadWebviewModule(path.join(MOCK_DATA_JS, "formHelpers.js")).__test__;
  });
  suiteTeardown(function () {
    delete (global as any).dataTypes;
    restore();
  });

  test("accepts a type that exists", function () {
    assert.strictEqual(helpers.checkForm("Job Title"), true);
  });

  test("rejects a type that does not", function () {
    // This is the gate on the whole submit path: an unrecognised value would be sent to Mockaroo
    // and come back as an opaque API error rather than a message about the form.
    assert.strictEqual(helpers.checkForm("Not A Real Mockaroo Type"), false);
  });

  test("rejects an empty field", function () {
    assert.strictEqual(helpers.checkForm(""), false);
    assert.strictEqual(helpers.checkForm(undefined), false);
  });

  test("matching is exact, not a prefix or substring", function () {
    assert.strictEqual(helpers.checkForm("Job"), false);
    assert.strictEqual(helpers.checkForm("job title"), false, "Mockaroo type names are case-sensitive");
  });
});

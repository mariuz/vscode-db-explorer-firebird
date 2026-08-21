import * as assert from "assert";
import {
  resolveTarget, generateTableDDL, buildPropertiesHtml, getLoadingHtml, getErrorHtml, escapeHtml,
  ObjectPropertiesTarget, FetchedMetadata
} from "../object-properties";
import { ConnectionOptions } from "../interfaces";

const conn: ConnectionOptions = {
  id: "conn-1", host: "localhost", port: 3050, database: "test.fdb", user: "sysdba", role: null,
};

const empty: FetchedMetadata = { columns: [], privileges: [], ddl: "", indexes: [] };

/**
 * `resolveTarget()` is duck-typed against the tree-node classes rather than instanceof-checked, so
 * its order of tests is load-bearing: the first shape that matches wins. These use hand-rolled
 * stubs with only the members it actually probes, which is also what pins that contract -- if a
 * node class gains a `getViewName()`, a real NodeTable would still have to resolve as a table.
 */
suite("Object Properties – resolveTarget()", function () {
  test("a table node resolves by its getTableName()", function () {
    const t = resolveTarget({ getTableName: () => "CUSTOMERS", getDbDetails: () => conn });
    assert.deepStrictEqual(t, { name: "CUSTOMERS", type: "table", dbDetails: conn });
  });

  test("a view node resolves by its getViewName()", function () {
    const t = resolveTarget({ getViewName: () => "V_CUSTOMERS", getDbDetails: () => conn });
    assert.strictEqual(t?.type, "view");
    assert.strictEqual(t?.name, "V_CUSTOMERS");
  });

  test("a procedure node resolves by its getProcedureName()", function () {
    const t = resolveTarget({ getProcedureName: () => "GET_STATS", dbDetails: conn });
    assert.strictEqual(t?.type, "procedure");
    assert.strictEqual(t?.dbDetails, conn);
  });

  test("a generator node resolves by its getGeneratorName()", function () {
    assert.strictEqual(resolveTarget({ getGeneratorName: () => "GEN_ID", dbDetails: conn })?.type, "generator");
  });

  test("a trigger node resolves from its raw catalogue row, trimming the padded name", function () {
    const t = resolveTarget({ trigger: { TRIGGER_NAME: "CUSTOMERS_BI   " }, dbDetails: conn });
    assert.deepStrictEqual(t, { name: "CUSTOMERS_BI", type: "trigger", dbDetails: conn });
  });

  test("a trigger row with no name at all falls back rather than producing undefined", function () {
    assert.strictEqual(resolveTarget({ trigger: {}, dbDetails: conn })?.name, "TRIGGER");
  });

  test("a domain node resolves from its raw catalogue row", function () {
    const t = resolveTarget({ domain: { DOMAIN_NAME: "D_EMAIL  " }, dbDetails: conn });
    assert.deepStrictEqual(t, { name: "D_EMAIL", type: "domain", dbDetails: conn });
  });

  test("a domain row with no name falls back", function () {
    assert.strictEqual(resolveTarget({ domain: {}, dbDetails: conn })?.name, "DOMAIN");
  });

  test("a role node resolves from its roleName property", function () {
    const t = resolveTarget({ roleName: " ADMIN_ROLE ", dbDetails: conn });
    assert.deepStrictEqual(t, { name: "ADMIN_ROLE", type: "role", dbDetails: conn });
  });

  test("an exception node resolves by getExceptionName() when it has one", function () {
    const t = resolveTarget({ getExceptionName: () => "E_NO_STOCK", dbDetails: conn });
    assert.deepStrictEqual(t, { name: "E_NO_STOCK", type: "exception", dbDetails: conn });
  });

  test("an exception node resolves from its catalogue row when it has no getter", function () {
    assert.strictEqual(resolveTarget({ exception: { EXCEPTION_NAME: "E_X " }, dbDetails: conn })?.name, "E_X");
  });

  test("a node exposing dbDetails as a property, not a getter, still resolves", function () {
    // Both spellings are in use across the node classes; the table branch tries the getter first.
    assert.strictEqual(resolveTarget({ getTableName: () => "T", dbDetails: conn })?.dbDetails, conn);
  });

  test("undefined in, undefined out -- the caller shows an error rather than opening a panel", function () {
    assert.strictEqual(resolveTarget(undefined), undefined);
    assert.strictEqual(resolveTarget(null), undefined);
  });

  test("an unrecognised node resolves to undefined rather than to a wrong type", function () {
    assert.strictEqual(resolveTarget({ somethingElse: true, dbDetails: conn }), undefined);
  });
});

suite("Object Properties – generateTableDDL()", function () {
  test("renders one line per column, comma-separated", function () {
    const ddl = generateTableDDL("CUSTOMERS", [
      { FIELD_NAME: "ID", FIELD_TYPE: "INTEGER", NOT_NULL: 1 },
      { FIELD_NAME: "NAME", FIELD_TYPE: "VARCHAR", FIELD_LENGTH: 60 },
    ]);
    assert.strictEqual(
      ddl,
      "CREATE TABLE CUSTOMERS (\n  ID INTEGER NOT NULL,\n  NAME VARCHAR(60)\n);"
    );
  });

  test("a length is rendered only for types that carry one", function () {
    const ddl = generateTableDDL("T", [{ FIELD_NAME: "C", FIELD_TYPE: "TIMESTAMP" }]);
    assert.strictEqual(ddl.split("\n")[1], "  C TIMESTAMP");
  });

  // RDB$DEFAULT_SOURCE carries the keyword itself -- verified against a live Firebird 6, where a
  // column declared DEFAULT 0 stores the literal string "DEFAULT 0". Re-adding it produced
  // `DEFAULT DEFAULT 0`, which no server would accept back.
  test("a default is emitted once, not doubled, when the catalogue value carries its own keyword", function () {
    const ddl = generateTableDDL("T", [
      { FIELD_NAME: "C", FIELD_TYPE: "INTEGER", NOT_NULL: 1, DFLT_VALUE: "DEFAULT 0" },
    ]);
    assert.strictEqual(ddl.split("\n")[1], "  C INTEGER DEFAULT 0 NOT NULL");
  });

  test("a string default keeps its quotes, and a default is placed before NOT NULL", function () {
    const ddl = generateTableDDL("T", [
      { FIELD_NAME: "C", FIELD_TYPE: "VARCHAR", FIELD_LENGTH: 10, NOT_NULL: 1, DFLT_VALUE: "DEFAULT 'hi'" },
    ]);
    assert.strictEqual(ddl.split("\n")[1], "  C VARCHAR(10) DEFAULT 'hi' NOT NULL");
  });

  test("a whitespace-only default is treated as no default at all", function () {
    const ddl = generateTableDDL("T", [{ FIELD_NAME: "C", FIELD_TYPE: "INTEGER", DFLT_VALUE: "   " }]);
    assert.strictEqual(ddl.split("\n")[1], "  C INTEGER");
  });

  test("no column metadata produces a commented stub, not a syntactically broken CREATE", function () {
    assert.strictEqual(
      generateTableDDL("T", []),
      "CREATE TABLE T (\n  -- No column metadata found\n);"
    );
    assert.ok(generateTableDDL("T", undefined as any).includes("No column metadata found"));
  });
});

suite("Object Properties – HTML rendering", function () {
  const target: ObjectPropertiesTarget = { name: "CUSTOMERS", type: "table", dbDetails: conn };

  test("escapeHtml() neutralises every character that could close a tag or an attribute", function () {
    assert.strictEqual(
      escapeHtml(`<script>alert("x")&'`),
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#039;"
    );
  });

  test("escapeHtml() escapes the ampersand first, so an escape is not double-escaped", function () {
    assert.strictEqual(escapeHtml("&lt;"), "&amp;lt;");
  });

  test("escapeHtml() survives a non-string", function () {
    assert.strictEqual(escapeHtml(undefined as any), "undefined");
    assert.strictEqual(escapeHtml(42 as any), "42");
  });

  // This panel runs with enableScripts: true, and a Firebird identifier may contain anything at
  // all when it was created quoted -- CREATE TABLE "<img src=x onerror=...>" is legal.
  test("the loading panel escapes the object name it was handed", function () {
    const html = getLoadingHtml('<img src=x onerror="boom">', "table");
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img"), html);
  });

  test("the error panel escapes both the name and the server's message", function () {
    const html = getErrorHtml("T", 'Token unknown - <script>alert(1)</script>');
    assert.ok(!html.includes("<script>alert(1)"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  test("the properties panel escapes the object name", function () {
    const html = buildPropertiesHtml({ ...target, name: '<b>X</b>' }, empty);
    assert.ok(html.includes("&lt;b&gt;X&lt;/b&gt;"), "name should be escaped");
  });

  test("the DDL is escaped rather than parsed as markup", function () {
    const html = buildPropertiesHtml(target, { ...empty, ddl: "SELECT * FROM T WHERE A < 1 AND B > 2" });
    assert.ok(html.includes("A &lt; 1 AND B &gt; 2"), "DDL should be escaped");
  });

  test("a table with columns gets a Columns tab, counted", function () {
    const html = buildPropertiesHtml(target, {
      ...empty,
      columns: [
        { FIELD_NAME: "ID", FIELD_TYPE: "INTEGER", NOT_NULL: 1 },
        { FIELD_NAME: "NAME", FIELD_TYPE: "VARCHAR", FIELD_LENGTH: 60 },
      ],
    });
    assert.ok(html.includes("Columns (2)"), "column count in the tab label");
    assert.ok(html.includes("✓ NOT NULL"), "a NOT NULL column says so");
    assert.ok(html.includes(">NULL<"), "a nullable column says so");
  });

  test("an object with no columns gets no Columns tab at all", function () {
    const html = buildPropertiesHtml({ ...target, type: "procedure" }, empty);
    assert.ok(!html.includes("Columns ("), "no empty Columns tab");
    assert.ok(!html.includes('id="columns"'), "no empty Columns panel");
  });

  test("indexes get their own tab only when there are some", function () {
    assert.ok(!buildPropertiesHtml(target, empty).includes("Indexes & Constraints"));
    const html = buildPropertiesHtml(target, {
      ...empty, indexes: [{ NAME: "PK_CUSTOMERS", TYPE: "PRIMARY KEY", FIELD: "ID" }],
    });
    assert.ok(html.includes("Indexes &amp; Constraints (1)") || html.includes("Indexes & Constraints (1)"), html.slice(0, 0) || "index tab");
    assert.ok(html.includes("PK_CUSTOMERS"));
  });

  test("the Grants tab is always present, and says so when there is nothing to show", function () {
    const html = buildPropertiesHtml(target, empty);
    assert.ok(html.includes("Grants (0)"));
    assert.ok(html.includes("No explicit grants recorded"));
  });

  test("a grant row reads from either the friendly or the raw RDB$ column name", function () {
    const html = buildPropertiesHtml(target, {
      ...empty,
      privileges: [
        { USER: "ALICE", PRIVILEGE: "SELECT", GRANT_OPTION: 1, GRANTOR: "SYSDBA" },
        { "RDB$USER": "BOB", "RDB$PRIVILEGE": "UPDATE", "RDB$GRANTOR": "SYSDBA" },
      ],
    });
    assert.ok(html.includes("Grants (2)"));
    assert.ok(html.includes("ALICE") && html.includes("BOB"), "both spellings render");
    assert.ok(html.includes(">Yes<") && html.includes(">No<"), "grant option rendered both ways");
  });

  test("a privilege value is escaped too -- it reaches the page from the catalogue", function () {
    const html = buildPropertiesHtml(target, { ...empty, privileges: [{ USER: "<b>", PRIVILEGE: "S" }] });
    assert.ok(!html.includes("<b>"), "grantee should be escaped");
  });
});

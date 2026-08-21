import * as assert from "assert";
import {
  parseObjectPath, buildObjectPath, requalifyDdl, applyMoveToManifestFiles,
  findReferencingFiles, SCHEMA_SCOPED_CATEGORIES
} from "../database-projects/move-to-schema";
import { getObjectPath } from "../database-projects/project-model";

suite("Database Projects – parseObjectPath()", function () {
  test("reads back the flat layout the default schema uses", function () {
    assert.deepStrictEqual(parseObjectPath("tables/ORDERS.sql"), { category: "tables", name: "ORDERS" });
  });

  test("reads back the schema-scoped layout", function () {
    assert.deepStrictEqual(
      parseObjectPath("schemas/SALES/tables/ORDERS.sql"),
      { schema: "SALES", category: "tables", name: "ORDERS" }
    );
  });

  // getObjectPath() is what writes these paths; parsing has to be its exact inverse or a move
  // would relocate a file to somewhere Build no longer looks.
  test("is the inverse of getObjectPath() for every schema-scoped category", function () {
    for (const category of SCHEMA_SCOPED_CATEGORIES) {
      const flat = getObjectPath(category, "THING");
      assert.deepStrictEqual(parseObjectPath(flat), { category, name: "THING" }, flat);

      const scoped = getObjectPath(category, "SALES.THING");
      assert.deepStrictEqual(parseObjectPath(scoped), { schema: "SALES", category, name: "THING" }, scoped);
    }
  });

  test("accepts Windows separators and a leading ./", function () {
    assert.deepStrictEqual(parseObjectPath("schemas\\SALES\\views\\V_X.sql"),
      { schema: "SALES", category: "views", name: "V_X" });
    assert.deepStrictEqual(parseObjectPath("./tables/ORDERS.sql"), { category: "tables", name: "ORDERS" });
  });

  // Firebird has no schema column on RDB$ROLES -- a role is database-wide -- so offering to move
  // one would promise something the server cannot represent. buildProjectFiles() writes roles/ and
  // users/ without going through getObjectPath() for exactly this reason.
  test("refuses roles and users, which are database-wide", function () {
    assert.strictEqual(parseObjectPath("roles/ADMIN.sql"), undefined);
    assert.strictEqual(parseObjectPath("users/ALICE.sql"), undefined);
  });

  test("refuses the foreign-key script and the manifest", function () {
    assert.strictEqual(parseObjectPath("foreign-keys.sql"), undefined);
    assert.strictEqual(parseObjectPath("firebird.project.json"), undefined);
  });

  test("refuses anything that is not shaped like a project object file", function () {
    assert.strictEqual(parseObjectPath("ORDERS.sql"), undefined, "no category folder");
    assert.strictEqual(parseObjectPath("tables/sub/ORDERS.sql"), undefined, "unexpected depth");
    assert.strictEqual(parseObjectPath("schemas/SALES/roles/ADMIN.sql"), undefined, "scoped role");
    assert.strictEqual(parseObjectPath("notes/tables/ORDERS.sql"), undefined, "not a schemas/ root");
    assert.strictEqual(parseObjectPath("tables/.sql"), undefined, "empty name");
    assert.strictEqual(parseObjectPath("tables/ORDERS.txt"), undefined, "not SQL");
  });
});

suite("Database Projects – buildObjectPath()", function () {
  test("a target schema produces the scoped layout", function () {
    assert.strictEqual(
      buildObjectPath({ category: "tables", name: "ORDERS" }, "SALES"),
      "schemas/SALES/tables/ORDERS.sql"
    );
  });

  // Moving back to the default schema has to restore the flat path, or an existing single-schema
  // project would be left with a schemas/PUBLIC/ tree that getObjectPath() would never produce.
  test("no target schema restores the flat layout", function () {
    assert.strictEqual(
      buildObjectPath({ schema: "SALES", category: "tables", name: "ORDERS" }),
      "tables/ORDERS.sql"
    );
  });

  test("sanitises a delimited identifier the same way extraction does", function () {
    assert.strictEqual(
      buildObjectPath({ category: "tables", name: "odd name" }, "we/ird"),
      "schemas/we_ird/tables/odd_name.sql"
    );
  });

  test("round-trips through parseObjectPath()", function () {
    const parsed = parseObjectPath("tables/ORDERS.sql")!;
    const moved = buildObjectPath(parsed, "SALES");
    assert.deepStrictEqual(parseObjectPath(moved), { schema: "SALES", category: "tables", name: "ORDERS" });
  });
});

suite("Database Projects – requalifyDdl()", function () {
  test("qualifies an unqualified CREATE TABLE header", function () {
    assert.strictEqual(
      requalifyDdl("CREATE TABLE ORDERS (\n  ID INTEGER\n);", "tables", "SALES"),
      "CREATE TABLE SALES.ORDERS (\n  ID INTEGER\n);"
    );
  });

  test("replaces an existing qualifier rather than stacking a second one", function () {
    assert.strictEqual(
      requalifyDdl("CREATE TABLE PUBLIC.ORDERS (\n  ID INTEGER\n);", "tables", "SALES"),
      "CREATE TABLE SALES.ORDERS (\n  ID INTEGER\n);"
    );
  });

  test("strips the qualifier when moving back to the default schema", function () {
    assert.strictEqual(
      requalifyDdl("CREATE TABLE SALES.ORDERS (\n  ID INTEGER\n);", "tables"),
      "CREATE TABLE ORDERS (\n  ID INTEGER\n);"
    );
  });

  test("handles the CREATE OR ALTER forms the builders emit", function () {
    assert.ok(requalifyDdl("CREATE OR ALTER VIEW V_X AS\nSELECT 1 FROM T;", "views", "S")
      .startsWith("CREATE OR ALTER VIEW S.V_X"));
    assert.ok(requalifyDdl("CREATE OR ALTER PROCEDURE P (A INTEGER)\nAS\nBEGIN END;", "procedures", "S")
      .startsWith("CREATE OR ALTER PROCEDURE S.P"));
    assert.ok(requalifyDdl("CREATE OR ALTER EXCEPTION E_X 'boom';", "exceptions", "S")
      .startsWith("CREATE OR ALTER EXCEPTION S.E_X"));
  });

  test("generators are introduced by SEQUENCE, which is what the builder emits", function () {
    assert.strictEqual(requalifyDdl("CREATE SEQUENCE GEN_ID;", "generators", "S"), "CREATE SEQUENCE S.GEN_ID;");
  });

  test("domains too", function () {
    assert.strictEqual(
      requalifyDdl("CREATE DOMAIN D_EMAIL AS VARCHAR(120);", "domains", "S"),
      "CREATE DOMAIN S.D_EMAIL AS VARCHAR(120);"
    );
  });

  // The whole reason this is a header rewrite and not a find-and-replace: a table named ORDERS
  // routinely mentions ORDERS again in a comment, a column or a constraint name, and rewriting
  // those to make one identifier look right would corrupt the file.
  test("only the header is touched, never a later mention of the same name", function () {
    const ddl = [
      "CREATE TABLE ORDERS (",
      "  ID INTEGER,",
      "  ORDERS_REF INTEGER,   -- ORDERS again",
      "  CONSTRAINT PK_ORDERS PRIMARY KEY (ID)",
      ");",
    ].join("\n");
    const out = requalifyDdl(ddl, "tables", "SALES");
    assert.ok(out.startsWith("CREATE TABLE SALES.ORDERS ("), out);
    assert.ok(out.includes("  ORDERS_REF INTEGER,   -- ORDERS again"), out);
    assert.ok(out.includes("CONSTRAINT PK_ORDERS PRIMARY KEY (ID)"), out);
    assert.strictEqual(out.match(/SALES\./g)?.length, 1, "exactly one qualifier added");
  });

  test("a trigger's own name is qualified but its FOR clause is left alone", function () {
    const out = requalifyDdl("CREATE OR ALTER TRIGGER T_BI\nFOR ORDERS ACTIVE BEFORE INSERT\nAS\nBEGIN END;", "triggers", "SALES");
    assert.ok(out.startsWith("CREATE OR ALTER TRIGGER SALES.T_BI"), out);
    assert.ok(out.includes("FOR ORDERS ACTIVE BEFORE INSERT"), out);
  });

  test("a delimited identifier survives", function () {
    assert.strictEqual(
      requalifyDdl('CREATE TABLE "odd name" (\n  ID INTEGER\n);', "tables", "SALES"),
      'CREATE TABLE SALES."odd name" (\n  ID INTEGER\n);'
    );
  });

  test("DDL with no recognisable header is returned untouched rather than mangled", function () {
    const ddl = "-- nothing to see here\n";
    assert.strictEqual(requalifyDdl(ddl, "tables", "SALES"), ddl);
  });
});

suite("Database Projects – applyMoveToManifestFiles()", function () {
  // Build concatenates in manifest order, and that order is dependency-safe: generators must run
  // before a trigger body calling GEN_ID() on them. A move must not reorder anything.
  test("replaces the path in place, preserving order", function () {
    const files = ["generators/GEN_ID.sql", "tables/ORDERS.sql", "triggers/T_BI.sql"];
    assert.deepStrictEqual(
      applyMoveToManifestFiles(files, "tables/ORDERS.sql", "schemas/SALES/tables/ORDERS.sql"),
      ["generators/GEN_ID.sql", "schemas/SALES/tables/ORDERS.sql", "triggers/T_BI.sql"]
    );
  });

  test("a path that is not listed leaves the manifest untouched", function () {
    const files = ["tables/ORDERS.sql"];
    assert.deepStrictEqual(applyMoveToManifestFiles(files, "tables/NOPE.sql", "x/y.sql"), files);
  });
});

suite("Database Projects – findReferencingFiles()", function () {
  test("names the other files mentioning the object, sorted, excluding its own", function () {
    const contents = new Map([
      ["tables/ORDERS.sql", "CREATE TABLE ORDERS (ID INTEGER);"],
      ["foreign-keys.sql", "ALTER TABLE LINES ADD FOREIGN KEY (ORDER_ID) REFERENCES ORDERS (ID);"],
      ["triggers/T_BI.sql", "CREATE OR ALTER TRIGGER T_BI\nFOR ORDERS ACTIVE BEFORE INSERT\nAS\nBEGIN END;"],
      ["tables/CUSTOMERS.sql", "CREATE TABLE CUSTOMERS (ID INTEGER);"],
    ]);
    assert.deepStrictEqual(
      findReferencingFiles(contents, "ORDERS", "tables/ORDERS.sql"),
      ["foreign-keys.sql", "triggers/T_BI.sql"]
    );
  });

  test("matches on a word boundary, so ORDERS does not hit ORDERS_ARCHIVE", function () {
    const contents = new Map([["tables/ORDERS_ARCHIVE.sql", "CREATE TABLE ORDERS_ARCHIVE (ID INTEGER);"]]);
    assert.deepStrictEqual(findReferencingFiles(contents, "ORDERS", "tables/ORDERS.sql"), []);
  });

  test("is case-insensitive, since Firebird DDL is written both ways", function () {
    const contents = new Map([["views/V.sql", "CREATE OR ALTER VIEW V AS SELECT * FROM orders;"]]);
    assert.deepStrictEqual(findReferencingFiles(contents, "ORDERS", "tables/ORDERS.sql"), ["views/V.sql"]);
  });

  test("a name containing regex metacharacters is matched literally, not as a pattern", function () {
    const contents = new Map([
      ["tables/A_B.sql", "CREATE TABLE A_B (ID INTEGER);"],
      ["views/V.sql", "CREATE OR ALTER VIEW V AS SELECT * FROM A.B;"],
    ]);
    assert.deepStrictEqual(findReferencingFiles(contents, "A.B", "views/V.sql"), []);
  });
});

/**
 * An end-to-end move over the pure pieces, on a project shaped exactly as buildProjectFiles()
 * writes one. This is what the command does to the file tree and the manifest; the command itself
 * only adds the file I/O and the prompts around it.
 */
suite("Database Projects – a whole move, end to end", function () {
  function project(): { files: string[]; contents: Map<string, string> } {
    const contents = new Map<string, string>([
      ["generators/GEN_ORDER_ID.sql", "CREATE SEQUENCE GEN_ORDER_ID;"],
      ["tables/ORDERS.sql", "CREATE TABLE ORDERS (\n  ID INTEGER NOT NULL,\n  CONSTRAINT PK_ORDERS PRIMARY KEY (ID)\n);"],
      ["tables/CUSTOMERS.sql", "CREATE TABLE CUSTOMERS (\n  ID INTEGER NOT NULL\n);"],
      ["foreign-keys.sql", "ALTER TABLE ORDERS ADD CONSTRAINT FK_O_C FOREIGN KEY (CUST_ID) REFERENCES CUSTOMERS (ID);"],
    ]);
    return { files: [...contents.keys()], contents };
  }

  test("moves the file, requalifies the header, and keeps the manifest order", function () {
    const { files, contents } = project();
    const parsed = parseObjectPath("tables/ORDERS.sql")!;
    const newPath = buildObjectPath(parsed, "SALES");

    assert.strictEqual(newPath, "schemas/SALES/tables/ORDERS.sql");
    assert.strictEqual(
      requalifyDdl(contents.get("tables/ORDERS.sql")!, parsed.category, "SALES").split("\n")[0],
      "CREATE TABLE SALES.ORDERS ("
    );
    assert.deepStrictEqual(
      applyMoveToManifestFiles(files, "tables/ORDERS.sql", newPath),
      ["generators/GEN_ORDER_ID.sql", "schemas/SALES/tables/ORDERS.sql", "tables/CUSTOMERS.sql", "foreign-keys.sql"]
    );
  });

  // The move is honest about its own limits: the foreign-key script still says REFERENCES ORDERS,
  // and nothing rewrites it. Reporting that beats letting the move look complete.
  test("reports the foreign-key script as still referring to the moved table", function () {
    const { contents } = project();
    assert.deepStrictEqual(
      findReferencingFiles(contents, "ORDERS", "tables/ORDERS.sql"),
      ["foreign-keys.sql"]
    );
  });

  test("a move back to the default schema is the exact inverse", function () {
    const moved = buildObjectPath(parseObjectPath("tables/ORDERS.sql")!, "SALES");
    const back = buildObjectPath(parseObjectPath(moved)!);
    assert.strictEqual(back, "tables/ORDERS.sql");
    assert.strictEqual(
      requalifyDdl(requalifyDdl("CREATE TABLE ORDERS (\n  ID INTEGER\n);", "tables", "SALES"), "tables"),
      "CREATE TABLE ORDERS (\n  ID INTEGER\n);"
    );
  });
});

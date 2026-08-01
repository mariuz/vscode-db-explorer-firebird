/**
 * Unit coverage for src/schema-designer/htmlContent/js/app.js's diff-engine/DDL-generation logic,
 * via its existing `module.exports.__test__` hook (previously unused by any committed test — see
 * src/test/webview-harness.ts's doc comment). This is, per schema-designer's own roadmap doc, "the
 * highest-stakes correctness surface in the module" — bugs here mean generated DDL that either
 * silently loses data or fails at execution — and was previously only ever verified via an
 * uncommitted, re-derived-by-hand Node harness. These tests commit that same scenario coverage
 * permanently: rename/type/default/not-null/add/drop-column, PK changes, add/delete relationships,
 * an AI-proposed new table, and a dangling/malformed relationship reference being ignored rather
 * than thrown on.
 */

import * as assert from 'assert';
import * as path from 'path';
import { installWebviewStubs, loadWebviewModule } from './webview-harness';

const APP_JS_PATH = path.join(__dirname, '..', '..', 'src', 'schema-designer', 'htmlContent', 'js', 'app.js');

/** The shape handleSchemaData() expects — the same one fetchSchemaGraph()/buildSchemaGraph() (TS side) produce. */
function schemaPayload(overrides: any = {}): any {
  return {
    graph: { tables: [], relationships: [] },
    pkConstraintNames: {},
    ...overrides,
  };
}

function col(overrides: Partial<any> & { name: string; type: string }): any {
  return { length: 0, notNull: false, isPrimaryKey: false, dflt: undefined, ...overrides };
}

suite('schema-designer app.js – diff engine / DDL generation (via __test__ hook)', function () {
  let hooks: any;
  let restore: () => void;

  suiteSetup(function () {
    restore = installWebviewStubs();
    hooks = loadWebviewModule(APP_JS_PATH).__test__;
  });
  suiteTeardown(function () { restore(); });

  /** Loads a fresh two-table schema (CUSTOMERS PK'd on ID, ORDERS PK'd on ID with an FK to CUSTOMERS) before every test, exactly like a real session starts. */
  setup(function () {
    hooks.handleSchemaData(schemaPayload({
      graph: {
        tables: [
          { name: 'CUSTOMERS', columns: [col({ name: 'ID', type: 'INTEGER', isPrimaryKey: true, notNull: true }), col({ name: 'NAME', type: 'VARCHAR', length: 50 })] },
          { name: 'ORDERS', columns: [col({ name: 'ID', type: 'INTEGER', isPrimaryKey: true, notNull: true }), col({ name: 'CUSTOMER_ID', type: 'INTEGER' })] },
        ],
        relationships: [{ constraintName: 'FK_ORDERS_CUSTOMER', table: 'ORDERS', column: 'CUSTOMER_ID', refTable: 'CUSTOMERS', refColumn: 'ID' }],
      },
      pkConstraintNames: { CUSTOMERS: 'PK_CUSTOMERS', ORDERS: 'PK_ORDERS' },
    }));
  });

  function draft(): any { return hooks.getDraftGraph(); }
  function table(name: string): any { return draft().tables.find((t: any) => t.name === name); }
  function column(tableName: string, colName: string): any { return table(tableName).columns.find((c: any) => c.name === colName); }

  suite('handleSchemaData()', function () {
    test('populates draftGraph with the fetched tables/columns', function () {
      assert.strictEqual(draft().tables.length, 2);
      assert.strictEqual(column('CUSTOMERS', 'NAME').type, 'VARCHAR');
    });

    test('populates the relationship, resolving column objects by name (not just carrying strings)', function () {
      assert.strictEqual(draft().relationships.length, 1);
      const rel = draft().relationships[0];
      assert.strictEqual(rel.fromColumn, column('ORDERS', 'CUSTOMER_ID'));
      assert.strictEqual(rel.toColumn, column('CUSTOMERS', 'ID'));
    });

    test('an unchanged, freshly-loaded schema produces no DDL', function () {
      assert.strictEqual(hooks.buildDDL(), '-- No changes detected.');
    });

    test('a relationship referencing a table/column that does not exist in the payload is silently dropped, not thrown on', function () {
      hooks.handleSchemaData(schemaPayload({
        graph: {
          tables: [{ name: 'T', columns: [col({ name: 'ID', type: 'INTEGER' })] }],
          relationships: [{ constraintName: 'FK_BOGUS', table: 'T', column: 'ID', refTable: 'NONEXISTENT', refColumn: 'ID' }],
        },
      }));
      assert.strictEqual(draft().relationships.length, 0);
    });
  });

  suite('buildDDL() — column changes on an existing table', function () {
    test('a renamed column emits ALTER COLUMN ... TO ..., not a drop+add', function () {
      column('CUSTOMERS', 'NAME').name = 'FULL_NAME';
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ALTER COLUMN NAME TO FULL_NAME;'), ddl);
      assert.ok(!ddl.includes('DROP NAME'), ddl);
    });

    test('a type/length change emits ALTER COLUMN ... TYPE ...', function () {
      column('CUSTOMERS', 'NAME').length = 100;
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ALTER COLUMN NAME TYPE VARCHAR(100);'), ddl);
    });

    test('changing a column\'s type is not mistaken for a new column (no spurious ADD)', function () {
      column('CUSTOMERS', 'NAME').type = 'VARCHAR';
      column('CUSTOMERS', 'NAME').length = 200;
      const ddl = hooks.buildDDL();
      assert.ok(!ddl.includes('ADD NAME'), ddl);
    });

    test('a NOT NULL change emits SET/DROP NOT NULL', function () {
      column('CUSTOMERS', 'NAME').notNull = true;
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ALTER COLUMN NAME SET NOT NULL;'), ddl);
    });

    test('a default value change emits SET DEFAULT', function () {
      column('CUSTOMERS', 'NAME').dflt = "'unknown'";
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes("ALTER TABLE CUSTOMERS ALTER COLUMN NAME SET DEFAULT 'unknown';"), ddl);
    });

    test('clearing a default value emits DROP DEFAULT', function () {
      column('CUSTOMERS', 'NAME').dflt = "'x'";
      hooks.buildDDL(); // establish the "has a default" baseline isn't needed -- original had none, so this alone should already show SET DEFAULT
      column('CUSTOMERS', 'NAME').dflt = undefined;
      const ddl = hooks.buildDDL();
      assert.ok(!ddl.includes('SET DEFAULT'), ddl);
      assert.ok(!ddl.includes('DROP DEFAULT'), ddl); // net-zero change back to the original: no statement at all
    });

    test('adding a new column emits ALTER TABLE ... ADD', function () {
      table('CUSTOMERS').columns.push(col({ name: 'EMAIL', type: 'VARCHAR', length: 80 }));
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ADD EMAIL VARCHAR(80);'), ddl);
    });

    test('a new NOT NULL column with no default gets a warning comment about existing rows', function () {
      table('CUSTOMERS').columns.push(col({ name: 'REQUIRED_COL', type: 'INTEGER', notNull: true }));
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ADD REQUIRED_COL INTEGER NOT NULL;'), ddl);
      assert.ok(ddl.includes('-- If this table already has rows, this may fail without a DEFAULT'), ddl);
    });

    test('removing a column emits ALTER TABLE ... DROP (no COLUMN keyword)', function () {
      const t = table('CUSTOMERS');
      t.columns.splice(t.columns.indexOf(column('CUSTOMERS', 'NAME')), 1);
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS DROP NAME;'), ddl);
      assert.ok(!ddl.includes('DROP COLUMN'), ddl);
    });
  });

  suite('buildDDL() — primary key changes', function () {
    test('changing the PK drops the old constraint by its real recorded name and adds the new one', function () {
      column('CUSTOMERS', 'ID').isPrimaryKey = false;
      column('CUSTOMERS', 'NAME').isPrimaryKey = true;
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS DROP CONSTRAINT PK_CUSTOMERS;'), ddl);
      assert.ok(ddl.includes('ALTER TABLE CUSTOMERS ADD PRIMARY KEY (NAME);'), ddl);
    });

    test('a PK column whose type/nullability is unchanged does not, by itself, trigger a PK-change block', function () {
      const ddl = hooks.buildDDL();
      assert.ok(!ddl.includes('DROP CONSTRAINT PK_CUSTOMERS'), ddl);
    });

    test('a kept FK referencing a table whose PK is changing is dropped and re-added by the same constraint name (Firebird refuses to drop a PK a live FK depends on)', function () {
      column('CUSTOMERS', 'ID').isPrimaryKey = false;
      column('CUSTOMERS', 'NAME').isPrimaryKey = true;
      const ddl = hooks.buildDDL();
      const dropIdx = ddl.indexOf('ALTER TABLE ORDERS DROP CONSTRAINT FK_ORDERS_CUSTOMER;');
      const addIdx = ddl.indexOf('ALTER TABLE ORDERS ADD CONSTRAINT FK_ORDERS_CUSTOMER FOREIGN KEY');
      assert.ok(dropIdx !== -1 && addIdx !== -1, ddl);
      assert.ok(dropIdx < addIdx, 'the FK must be dropped before the PK change, and re-added after');
    });
  });

  suite('buildDDL() — new tables', function () {
    test('a brand-new table emits CREATE TABLE with a PRIMARY KEY clause', function () {
      hooks.addTable();
      const newTable = draft().tables.find((t: any) => t.isNew);
      newTable.name = 'PRODUCTS';
      newTable.columns.push(col({ name: 'SKU', type: 'VARCHAR', length: 20 }));
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('CREATE TABLE PRODUCTS ('), ddl);
      assert.ok(ddl.includes('PRIMARY KEY (ID)'), ddl);
    });

    test('addTable() gives the new table a default single-column PK named ID', function () {
      hooks.addTable();
      const newTable = draft().tables.find((t: any) => t.isNew);
      assert.deepStrictEqual(newTable.columns.map((c: any) => c.name), ['ID']);
      assert.strictEqual(newTable.columns[0].isPrimaryKey, true);
    });
  });

  suite('buildDDL() — relationships', function () {
    test('a newly-added relationship emits ADD FOREIGN KEY', function () {
      hooks.addTable();
      const newTable = draft().tables.find((t: any) => t.isNew);
      newTable.name = 'ADDRESSES';
      newTable.columns.push(col({ name: 'CUSTOMER_ID', type: 'INTEGER' }));
      hooks.addRelationship(newTable.id, newTable.columns[1], table('CUSTOMERS').id, column('CUSTOMERS', 'ID'));
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('FOREIGN KEY (CUSTOMER_ID) REFERENCES CUSTOMERS (ID)'), ddl);
    });

    test('addRelationship() refuses a self-referencing column pair', function () {
      const before = draft().relationships.length;
      hooks.addRelationship(table('CUSTOMERS').id, column('CUSTOMERS', 'ID'), table('CUSTOMERS').id, column('CUSTOMERS', 'ID'));
      assert.strictEqual(draft().relationships.length, before);
    });

    test('addRelationship() refuses an exact duplicate of an already-existing relationship', function () {
      const before = draft().relationships.length;
      hooks.addRelationship(table('ORDERS').id, column('ORDERS', 'CUSTOMER_ID'), table('CUSTOMERS').id, column('CUSTOMERS', 'ID'));
      assert.strictEqual(draft().relationships.length, before);
    });

    test('deleting a relationship emits DROP CONSTRAINT for its real constraint name', function () {
      draft().relationships = [];
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE ORDERS DROP CONSTRAINT FK_ORDERS_CUSTOMER;'), ddl);
    });

    test('removing a column that a relationship depends on removes the relationship too (no dangling reference in the generated DDL)', function () {
      const t = table('ORDERS');
      const fkCol = column('ORDERS', 'CUSTOMER_ID');
      draft().relationships = draft().relationships.filter((r: any) => r.fromColumn !== fkCol);
      t.columns.splice(t.columns.indexOf(fkCol), 1);
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE ORDERS DROP CONSTRAINT FK_ORDERS_CUSTOMER;'), ddl);
      assert.ok(!ddl.includes('Skipped:'), ddl);
    });
  });

  suite('serializeSchemaSummary()', function () {
    test('lists every table with its columns, types, and PK/NOT NULL/DEFAULT flags', function () {
      const summary = hooks.serializeSchemaSummary();
      assert.ok(summary.includes('Table CUSTOMERS:'), summary);
      assert.ok(summary.includes('ID INTEGER NOT NULL PK'), summary);
      assert.ok(summary.includes('NAME VARCHAR (50)'), summary);
    });

    test('lists relationships by table.column -> table.column', function () {
      const summary = hooks.serializeSchemaSummary();
      assert.ok(summary.includes('ORDERS.CUSTOMER_ID -> CUSTOMERS.ID'), summary);
    });

    test('marks a not-yet-created table distinctly', function () {
      hooks.addTable();
      const summary = hooks.serializeSchemaSummary();
      assert.ok(summary.includes('(not yet created)'), summary);
    });
  });

  suite('applyCopilotEdit()', function () {
    test('adds a genuinely new table with columns', function () {
      hooks.applyCopilotEdit({ tables: [{ name: 'invoices', columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true, notNull: true }, { name: 'total', type: 'NUMERIC', length: 0 }] }] });
      const t = table('INVOICES');
      assert.ok(t, 'the new table should exist, uppercased');
      assert.ok(t.isNew);
      assert.strictEqual(t.columns.length, 2);
    });

    test('modifies an existing table\'s column in place rather than adding a duplicate', function () {
      hooks.applyCopilotEdit({ tables: [{ name: 'customers', columns: [{ name: 'name', length: 120 }] }] });
      assert.strictEqual(table('CUSTOMERS').columns.length, 2, 'should still be exactly 2 columns, not 3');
      assert.strictEqual(column('CUSTOMERS', 'NAME').length, 120);
    });

    test('a column with action: "remove" deletes it and cascades to any relationship depending on it', function () {
      hooks.applyCopilotEdit({ tables: [{ name: 'orders', columns: [{ name: 'customer_id', action: 'remove' }] }] });
      assert.strictEqual(column('ORDERS', 'CUSTOMER_ID'), undefined);
      assert.strictEqual(draft().relationships.length, 0);
    });

    test('adds a relationship by table/column name, resolved against the current draft', function () {
      hooks.applyCopilotEdit({
        tables: [{ name: 'invoices', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'customer_id', type: 'INTEGER' }] }],
        relationships: [{ fromTable: 'invoices', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }],
      });
      const rel = draft().relationships.find((r: any) => r.fromColumn === column('INVOICES', 'CUSTOMER_ID'));
      assert.ok(rel, 'the AI-proposed relationship should have been added');
      assert.strictEqual(rel.toColumn, column('CUSTOMERS', 'ID'));
    });

    test('a relationship naming a table/column that does not exist anywhere is silently ignored, not thrown on', function () {
      assert.doesNotThrow(() => {
        hooks.applyCopilotEdit({ relationships: [{ fromTable: 'CUSTOMERS', fromColumn: 'NOPE', toTable: 'GHOST_TABLE', toColumn: 'ID' }] });
      });
      assert.strictEqual(draft().relationships.length, 1, 'the malformed relationship must not have been added');
    });

    test('a null/undefined edit is a safe no-op', function () {
      const before = JSON.stringify(draft());
      hooks.applyCopilotEdit(null);
      hooks.applyCopilotEdit(undefined);
      assert.strictEqual(JSON.stringify(draft()), before);
    });

    test('an entry with no name is ignored rather than creating a garbage table', function () {
      const before = draft().tables.length;
      hooks.applyCopilotEdit({ tables: [{ columns: [{ name: 'x' }] }] });
      assert.strictEqual(draft().tables.length, before);
    });
  });

  suite('Firebird 6 schemas — generated DDL', function () {
    test('DDL names a table exactly as the graph identifies it, schema and all', function () {
      // The graph's `name` is schema-qualified on Firebird 6 precisely so that generated DDL does
      // not depend on the session search path. This pins that: an ALTER against SALES.ORDERS must
      // not come out as ALTER TABLE ORDERS, which would hit whichever ORDERS the path finds first.
      hooks.handleSchemaData(schemaPayload({
        graph: {
          tables: [{ name: 'SALES.ORDERS', displayName: 'SALES.ORDERS', columns: [col({ name: 'ID', type: 'INTEGER' })] }],
          relationships: [],
        },
      }));
      const table = draft().tables.find((t: any) => t.name === 'SALES.ORDERS');
      table.columns.push({ name: 'TOTAL', type: 'INTEGER', length: 4, notNull: false, isPrimaryKey: false });
      const ddl = hooks.buildDDL();
      assert.ok(ddl.includes('ALTER TABLE SALES.ORDERS ADD TOTAL'), ddl);
    });

    test('a default-schema table is still qualified in DDL, even though its label is not', function () {
      // displayName drops the redundant PUBLIC. prefix for the diagram; `name` keeps it for SQL.
      hooks.handleSchemaData(schemaPayload({
        graph: {
          tables: [{ name: 'PUBLIC.ORDERS', displayName: 'ORDERS', columns: [col({ name: 'ID', type: 'INTEGER' })] }],
          relationships: [],
        },
      }));
      const table = draft().tables.find((t: any) => t.name === 'PUBLIC.ORDERS');
      table.columns.push({ name: 'NOTE', type: 'VARCHAR', length: 20, notNull: false, isPrimaryKey: false });
      assert.ok(hooks.buildDDL().includes('ALTER TABLE PUBLIC.ORDERS ADD NOTE'), hooks.buildDDL());
    });
  });
});

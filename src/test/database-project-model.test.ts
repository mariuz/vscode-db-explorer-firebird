import * as assert from 'assert';
import {
  columnTypeToDDL, buildTableCreateDDL, buildForeignKeyDDL, buildProcedureCreateDDL,
  buildProcedureParameterHeader, buildTriggerCreateDDL, buildViewCreateDDL, buildGeneratorCreateDDL,
  buildDomainCreateDDL, buildExceptionCreateDDL, buildRoleCreateDDL, buildUserCreateDDL,
  sanitizeFileName, buildProjectFiles, MANIFEST_FILE_NAME, ProjectInput, ProcedureParameter, DomainSource,
} from '../database-projects/project-model';
import { SchemaColumn, SchemaTable, SchemaGraph, SchemaRelationship } from '../schema-designer/schema-graph';

function column(overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name: 'ID', type: 'INTEGER', length: 0, notNull: true, isPrimaryKey: false, ...overrides };
}

suite('database-project-model – columnTypeToDDL()', function () {
  test('VARCHAR/CHAR/CSTRING get a length', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'VARCHAR', length: 50 })), 'VARCHAR(50)');
    assert.strictEqual(columnTypeToDDL(column({ type: 'CHAR', length: 10 })), 'CHAR(10)');
    assert.strictEqual(columnTypeToDDL(column({ type: 'CSTRING', length: 20 })), 'VARCHAR(20)');
  });

  test('a zero/missing length still produces a valid VARCHAR(1)/CHAR(1)', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'VARCHAR', length: 0 })), 'VARCHAR(1)');
  });

  test('INT64 maps to BIGINT', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'INT64' })), 'BIGINT');
  });

  test('DOUBLE and D_FLOAT both map to DOUBLE PRECISION', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'DOUBLE' })), 'DOUBLE PRECISION');
    assert.strictEqual(columnTypeToDDL(column({ type: 'D_FLOAT' })), 'DOUBLE PRECISION');
  });

  test('SMALLINT/INTEGER/FLOAT/DATE/TIME/TIMESTAMP/BLOB pass through unchanged', function () {
    for (const t of ['SMALLINT', 'INTEGER', 'FLOAT', 'DATE', 'TIME', 'TIMESTAMP', 'BLOB']) {
      assert.strictEqual(columnTypeToDDL(column({ type: t })), t);
    }
  });

  test('an unrecognized/UNKNOWN type falls back to VARCHAR(255)', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'UNKNOWN' })), 'VARCHAR(255)');
  });

  // subType 1 = NUMERIC, 2 = DECIMAL, scale is negative (decimal places = -scale) — confirmed
  // directly against a live Firebird server, not assumed.
  test('subType 1 (NUMERIC) with a precision/scale overrides the underlying INTEGER/BIGINT type', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'INTEGER', subType: 1, precision: 9, scale: -2 })), 'NUMERIC(9,2)');
    assert.strictEqual(columnTypeToDDL(column({ type: 'INT64', subType: 1, precision: 18, scale: -4 })), 'NUMERIC(18,4)');
  });

  test('subType 2 (DECIMAL) with a precision/scale overrides the underlying type', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'INT64', subType: 2, precision: 10, scale: -3 })), 'DECIMAL(10,3)');
  });

  test('subType 0 (plain, non-fixed-point) is not treated as NUMERIC/DECIMAL', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'INTEGER', subType: 0, precision: 0, scale: 0 })), 'INTEGER');
  });

  test('a DOUBLE column has no subType at all (Firebird only sets it for INTEGER/BIGINT-backed fixed-point types)', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'DOUBLE', subType: undefined, precision: undefined })), 'DOUBLE PRECISION');
  });

  test('a scale of 0 (whole-number NUMERIC, e.g. NUMERIC(9,0)) still works', function () {
    assert.strictEqual(columnTypeToDDL(column({ type: 'INTEGER', subType: 1, precision: 9, scale: 0 })), 'NUMERIC(9,0)');
  });
});

suite('database-project-model – buildTableCreateDDL()', function () {
  test('builds one column line per column plus a trailing PRIMARY KEY clause', function () {
    const table: SchemaTable = {
      name: 'CUSTOMERS',
      columns: [
        column({ name: 'ID', type: 'INTEGER', isPrimaryKey: true, notNull: true }),
        column({ name: 'NAME', type: 'VARCHAR', length: 100, notNull: true }),
      ],
    };
    assert.strictEqual(
      buildTableCreateDDL(table),
      'CREATE TABLE CUSTOMERS (\n  ID INTEGER NOT NULL,\n  NAME VARCHAR(100) NOT NULL,\n  PRIMARY KEY (ID)\n);'
    );
  });

  test('omits the PRIMARY KEY clause when no column is a primary key', function () {
    const table: SchemaTable = { name: 'LOG', columns: [column({ name: 'MSG', type: 'VARCHAR', length: 50, notNull: false, isPrimaryKey: false })] };
    const ddl = buildTableCreateDDL(table);
    assert.ok(!ddl.includes('PRIMARY KEY'));
  });

  test('includes a DEFAULT clause before NOT NULL when the column has one', function () {
    const table: SchemaTable = { name: 'T', columns: [column({ name: 'STATUS', type: 'VARCHAR', length: 10, notNull: true, dflt: "'ACTIVE'" })] };
    assert.ok(buildTableCreateDDL(table).includes("STATUS VARCHAR(10) DEFAULT 'ACTIVE' NOT NULL"));
  });

  test('lists a composite primary key in column order', function () {
    const table: SchemaTable = {
      name: 'ORDER_ITEMS',
      columns: [
        column({ name: 'ORDER_ID', isPrimaryKey: true }),
        column({ name: 'LINE_NO', isPrimaryKey: true }),
      ],
    };
    assert.ok(buildTableCreateDDL(table).includes('PRIMARY KEY (ORDER_ID, LINE_NO)'));
  });
});

suite('database-project-model – buildForeignKeyDDL()', function () {
  test('builds an ALTER TABLE ADD CONSTRAINT FOREIGN KEY statement', function () {
    const rel: SchemaRelationship = { constraintName: 'FK_ORDERS_CUST', table: 'ORDERS', column: 'CUSTOMER_ID', refTable: 'CUSTOMERS', refColumn: 'ID' };
    assert.strictEqual(
      buildForeignKeyDDL(rel),
      'ALTER TABLE ORDERS ADD CONSTRAINT FK_ORDERS_CUST FOREIGN KEY (CUSTOMER_ID) REFERENCES CUSTOMERS (ID);'
    );
  });
});

suite('database-project-model – object DDL builders (CREATE OR ALTER)', function () {
  // NOTE: RDB$PROCEDURE_SOURCE itself never includes the parameter list/RETURNS clause (confirmed
  // against a live server) — buildProcedureCreateDDL() reconstructs it separately from the
  // procedure's `parameters` field instead (see the "parameterized procedures" suite below).
  // Fixtures with no `parameters` field exercise the parameterless case.
  test('buildProcedureCreateDDL wraps the raw source with CREATE OR ALTER PROCEDURE <name>', function () {
    const ddl = buildProcedureCreateDDL({ name: 'GET_TOTAL', source: 'BEGIN\n  TOTAL = 1;\nEND' });
    assert.ok(ddl.startsWith('CREATE OR ALTER PROCEDURE GET_TOTAL\nAS\nBEGIN'), ddl);
  });

  test('buildProcedureCreateDDL inserts "AS" — RDB$PROCEDURE_SOURCE never includes it, confirmed against a live server', function () {
    const ddl = buildProcedureCreateDDL({ name: 'P', source: 'BEGIN EXIT; END' });
    assert.ok(ddl.startsWith('CREATE OR ALTER PROCEDURE P\nAS\nBEGIN EXIT; END'), ddl);
  });

  test('buildProcedureCreateDDL ends with a trailing ";" — needed so concatenating multiple objects with no SET TERM stays splittable', function () {
    const ddl = buildProcedureCreateDDL({ name: 'P', source: 'BEGIN EXIT; END' });
    assert.ok(ddl.endsWith('END;'), ddl);
  });

  test('buildTriggerCreateDDL reconstructs the FOR <table> ACTIVE/INACTIVE <event> header — RDB$TRIGGER_SOURCE never includes it, confirmed against a live server', function () {
    const ddl = buildTriggerCreateDDL({ name: 'TR_AUDIT', table: 'ORDERS', inactive: false, type: 1, source: 'AS\nBEGIN\nEND' });
    assert.ok(ddl.startsWith('CREATE OR ALTER TRIGGER TR_AUDIT\nFOR ORDERS ACTIVE BEFORE INSERT\n'), ddl);
  });

  test('buildTriggerCreateDDL emits INACTIVE for a disabled trigger', function () {
    const ddl = buildTriggerCreateDDL({ name: 'TR1', table: 'T', inactive: true, type: 4, source: 'AS BEGIN END' });
    assert.ok(ddl.includes('FOR T INACTIVE AFTER UPDATE'), ddl);
  });

  test('buildTriggerCreateDDL ends with a trailing ";"', function () {
    const ddl = buildTriggerCreateDDL({ name: 'TR1', table: 'T', inactive: false, type: 1, source: 'AS BEGIN END' });
    assert.ok(ddl.endsWith('END;'), ddl);
  });

  test('buildViewCreateDDL wraps the raw source with CREATE OR ALTER VIEW <name> AS', function () {
    const ddl = buildViewCreateDDL({ name: 'V_ACTIVE_ORDERS', source: 'SELECT * FROM ORDERS WHERE STATUS = 1' });
    assert.strictEqual(ddl, 'CREATE OR ALTER VIEW V_ACTIVE_ORDERS AS\nSELECT * FROM ORDERS WHERE STATUS = 1;');
  });

  test('buildGeneratorCreateDDL builds a plain CREATE SEQUENCE statement', function () {
    assert.strictEqual(buildGeneratorCreateDDL('GEN_ORDER_ID'), 'CREATE SEQUENCE GEN_ORDER_ID;');
  });
});

// ── domains/exceptions/roles/users (docs/roadmap/database-projects.md, extending Extract/Build/
// Publish beyond tables/views/procedures/triggers/generators) ─────────────────────────────────

function domain(overrides: Partial<DomainSource> & { name: string } = { name: 'D_TEST' }): DomainSource {
  return { type: 'INTEGER', length: 4, notNull: false, ...overrides };
}

suite('database-project-model – buildDomainCreateDDL()', function () {
  test('a bare domain (no default/not null/check) is just CREATE DOMAIN name AS type', function () {
    assert.strictEqual(buildDomainCreateDDL(domain({ name: 'D_AGE', type: 'INTEGER' })), 'CREATE DOMAIN D_AGE AS INTEGER;');
  });

  test('includes DEFAULT when set', function () {
    assert.strictEqual(buildDomainCreateDDL(domain({ name: 'D_AGE', dflt: '0' })), 'CREATE DOMAIN D_AGE AS INTEGER DEFAULT 0;');
  });

  test('includes NOT NULL when set', function () {
    assert.strictEqual(buildDomainCreateDDL(domain({ name: 'D_AGE', notNull: true })), 'CREATE DOMAIN D_AGE AS INTEGER NOT NULL;');
  });

  test('includes the CHECK clause verbatim (it already carries its own "CHECK (...)" wrapper)', function () {
    assert.strictEqual(
      buildDomainCreateDDL(domain({ name: 'D_AGE', check: 'CHECK (VALUE >= 0)' })),
      'CREATE DOMAIN D_AGE AS INTEGER CHECK (VALUE >= 0);'
    );
  });

  test('combines default, not null, and check in that order, matching CREATE DOMAIN grammar', function () {
    const ddl = buildDomainCreateDDL(domain({ name: 'D_AGE', dflt: '0', notNull: true, check: 'CHECK (VALUE >= 0)' }));
    assert.strictEqual(ddl, 'CREATE DOMAIN D_AGE AS INTEGER DEFAULT 0 NOT NULL CHECK (VALUE >= 0);');
  });

  test('uses columnTypeToDDL()\'s NUMERIC/DECIMAL reconstruction for a fixed-point domain', function () {
    const ddl = buildDomainCreateDDL(domain({ name: 'D_MONEY', type: 'INTEGER', subType: 1, precision: 9, scale: -2 }));
    assert.strictEqual(ddl, 'CREATE DOMAIN D_MONEY AS NUMERIC(9,2);');
  });

  test('VARCHAR domain gets a length', function () {
    assert.strictEqual(buildDomainCreateDDL(domain({ name: 'D_EMAIL', type: 'VARCHAR', length: 150 })), 'CREATE DOMAIN D_EMAIL AS VARCHAR(150);');
  });
});

suite('database-project-model – buildExceptionCreateDDL()', function () {
  test('wraps the message with CREATE OR ALTER EXCEPTION <name> \'<message>\'', function () {
    assert.strictEqual(
      buildExceptionCreateDDL({ name: 'EXC_NOT_FOUND', message: 'Record not found' }),
      "CREATE OR ALTER EXCEPTION EXC_NOT_FOUND 'Record not found';"
    );
  });

  test('escapes an embedded single quote in the message', function () {
    assert.strictEqual(
      buildExceptionCreateDDL({ name: 'EXC_1', message: "it wasn't supposed to happen" }),
      "CREATE OR ALTER EXCEPTION EXC_1 'it wasn''t supposed to happen';"
    );
  });

  test('handles an empty message', function () {
    assert.strictEqual(buildExceptionCreateDDL({ name: 'EXC_EMPTY', message: '' }), "CREATE OR ALTER EXCEPTION EXC_EMPTY '';");
  });

  test('uses CREATE OR ALTER (not plain CREATE) — confirmed live that Firebird supports this for EXCEPTION, unlike DOMAIN/ROLE', function () {
    const ddl = buildExceptionCreateDDL({ name: 'EXC_1', message: 'x' });
    assert.ok(ddl.startsWith('CREATE OR ALTER EXCEPTION'), ddl);
  });
});

suite('database-project-model – buildRoleCreateDDL()', function () {
  test('builds a plain CREATE ROLE statement — no CREATE OR ALTER exists for ROLE, confirmed live', function () {
    assert.strictEqual(buildRoleCreateDDL({ name: 'APP_ROLE' }), 'CREATE ROLE APP_ROLE;');
  });
});

suite('database-project-model – buildUserCreateDDL()', function () {
  test('is commented out — Firebird cannot export a real password, so this must never be silently executable', function () {
    const ddl = buildUserCreateDDL({ name: 'JOHN_DOE' });
    assert.ok(ddl.startsWith('-- '), `expected the statement to be commented out, got: ${ddl}`);
  });

  test('still names the exact user and a real CREATE USER statement, for the reviewer to uncomment', function () {
    const ddl = buildUserCreateDDL({ name: 'JOHN_DOE' });
    assert.ok(ddl.includes('CREATE USER JOHN_DOE PASSWORD'), ddl);
  });

  test('flags that the password is a placeholder needing manual attention', function () {
    const ddl = buildUserCreateDDL({ name: 'JOHN_DOE' });
    assert.ok(/TODO/i.test(ddl), ddl);
  });
});

suite('database-project-model – parameterized procedures', function () {
  function param(overrides: Partial<ProcedureParameter> = {}): ProcedureParameter {
    return { name: 'X', direction: 'in', type: 'INTEGER', length: 4, ...overrides };
  }

  test('buildProcedureParameterHeader returns "" for a parameterless procedure', function () {
    assert.strictEqual(buildProcedureParameterHeader([]), '');
  });

  test('buildProcedureParameterHeader builds just the input list when there are no output params', function () {
    const header = buildProcedureParameterHeader([param({ name: 'X', type: 'INTEGER' })]);
    assert.strictEqual(header, '(X INTEGER)');
  });

  test('buildProcedureParameterHeader builds just RETURNS when there are no input params', function () {
    const header = buildProcedureParameterHeader([param({ name: 'Y', direction: 'out', type: 'INTEGER' })]);
    assert.strictEqual(header, 'RETURNS (Y INTEGER)');
  });

  test('buildProcedureParameterHeader builds both input list and RETURNS, in that order', function () {
    const header = buildProcedureParameterHeader([
      param({ name: 'X', direction: 'in', type: 'INTEGER' }),
      param({ name: 'Y', direction: 'out', type: 'INTEGER' }),
    ]);
    assert.strictEqual(header, '(X INTEGER)\nRETURNS (Y INTEGER)');
  });

  test('buildProcedureParameterHeader joins multiple parameters of the same direction with ", "', function () {
    const header = buildProcedureParameterHeader([
      param({ name: 'X', direction: 'in', type: 'INTEGER' }),
      param({ name: 'CODE', direction: 'in', type: 'VARCHAR', length: 10 }),
    ]);
    assert.strictEqual(header, '(X INTEGER, CODE VARCHAR(10))');
  });

  test('buildProcedureParameterHeader reuses columnTypeToDDL for NUMERIC/DECIMAL parameters', function () {
    const header = buildProcedureParameterHeader([param({ name: 'AMT', direction: 'in', type: 'INTEGER', subType: 1, precision: 9, scale: -2 })]);
    assert.strictEqual(header, '(AMT NUMERIC(9,2))');
  });

  test('buildProcedureCreateDDL includes the parameter header between the name and AS', function () {
    const ddl = buildProcedureCreateDDL({
      name: 'GET_TOTAL',
      source: 'BEGIN\n  TOTAL = X;\n  SUSPEND;\nEND',
      parameters: [param({ name: 'X', direction: 'in' }), param({ name: 'TOTAL', direction: 'out' })],
    });
    assert.strictEqual(ddl, 'CREATE OR ALTER PROCEDURE GET_TOTAL\n(X INTEGER)\nRETURNS (TOTAL INTEGER)\nAS\nBEGIN\n  TOTAL = X;\n  SUSPEND;\nEND;');
  });

  test('buildProcedureCreateDDL omits the header entirely for a parameterless procedure (no empty parens)', function () {
    const ddl = buildProcedureCreateDDL({ name: 'P', source: 'BEGIN EXIT; END' });
    assert.strictEqual(ddl, 'CREATE OR ALTER PROCEDURE P\nAS\nBEGIN EXIT; END;');
  });
});

suite('database-project-model – sanitizeFileName()', function () {
  test('leaves an ordinary Firebird identifier unchanged', function () {
    assert.strictEqual(sanitizeFileName('CUSTOMERS'), 'CUSTOMERS');
  });

  test('replaces characters that are unsafe in a filename', function () {
    assert.strictEqual(sanitizeFileName('weird/name:here'), 'weird_name_here');
  });
});

suite('database-project-model – buildProjectFiles()', function () {
  function baseInput(overrides: Partial<ProjectInput> = {}): ProjectInput {
    const graph: SchemaGraph = { tables: [], relationships: [] };
    return {
      graph, domains: [], procedures: [], triggers: [], views: [], generators: [],
      exceptions: [], roles: [], users: [], pkConstraintNames: {}, ...overrides,
    };
  }

  test('always emits the manifest file first', function () {
    const files = buildProjectFiles(baseInput());
    assert.strictEqual(files[0].path, MANIFEST_FILE_NAME);
  });

  test('the manifest lists every other file, in emission order', function () {
    const input = baseInput({
      graph: { tables: [{ name: 'A', columns: [column()] }], relationships: [] },
      views: [{ name: 'V', source: 'SELECT 1 FROM RDB$DATABASE' }],
      generators: ['GEN_A'],
    });
    const files = buildProjectFiles(input);
    const manifest = JSON.parse(files[0].content);
    assert.deepStrictEqual(manifest.files, files.slice(1).map(f => f.path));
    assert.deepStrictEqual(manifest.files, ['generators/GEN_A.sql', 'tables/A.sql', 'views/V.sql']);
  });

  test('writes one file per table under tables/', function () {
    const input = baseInput({ graph: { tables: [{ name: 'CUSTOMERS', columns: [column()] }], relationships: [] } });
    const files = buildProjectFiles(input);
    assert.ok(files.some(f => f.path === 'tables/CUSTOMERS.sql'));
  });

  test('emits a single foreign-keys.sql only when there is at least one relationship', function () {
    const withFk = buildProjectFiles(baseInput({
      graph: { tables: [], relationships: [{ constraintName: 'FK1', table: 'A', column: 'B_ID', refTable: 'B', refColumn: 'ID' }] },
    }));
    assert.ok(withFk.some(f => f.path === 'foreign-keys.sql'));

    const withoutFk = buildProjectFiles(baseInput());
    assert.ok(!withoutFk.some(f => f.path === 'foreign-keys.sql'));
  });

  test('writes one file per view/procedure/trigger/generator under their own folder', function () {
    const files = buildProjectFiles(baseInput({
      views: [{ name: 'V1', source: 'SELECT 1 FROM RDB$DATABASE' }],
      procedures: [{ name: 'P1', source: 'AS\nBEGIN\nEND' }],
      triggers: [{ name: 'T1', table: 'A', inactive: false, type: 1, source: 'AS\nBEGIN\nEND' }],
      generators: ['G1'],
    }));
    assert.ok(files.some(f => f.path === 'views/V1.sql'));
    assert.ok(files.some(f => f.path === 'procedures/P1.sql'));
    assert.ok(files.some(f => f.path === 'triggers/T1.sql'));
    assert.ok(files.some(f => f.path === 'generators/G1.sql'));
  });

  test('orders files as generators, domains, tables, foreign keys, exceptions, views, procedures, triggers, roles, users', function () {
    const files = buildProjectFiles(baseInput({
      domains: [{ name: 'D1', type: 'INTEGER', length: 4, notNull: false }],
      graph: { tables: [{ name: 'A', columns: [column()] }], relationships: [{ constraintName: 'FK1', table: 'A', column: 'B_ID', refTable: 'B', refColumn: 'ID' }] },
      exceptions: [{ name: 'E1', message: 'oops' }],
      views: [{ name: 'V1', source: 'SELECT 1 FROM RDB$DATABASE' }],
      procedures: [{ name: 'P1', source: 'AS\nBEGIN\nEND' }],
      triggers: [{ name: 'T1', table: 'A', inactive: false, type: 1, source: 'AS\nBEGIN\nEND' }],
      generators: ['G1'],
      roles: [{ name: 'R1' }],
      users: [{ name: 'U1' }],
    }));
    const order = files.map(f => f.path);
    assert.deepStrictEqual(order, [
      MANIFEST_FILE_NAME, 'generators/G1.sql', 'domains/D1.sql', 'tables/A.sql', 'foreign-keys.sql', 'exceptions/E1.sql',
      'views/V1.sql', 'procedures/P1.sql', 'triggers/T1.sql', 'roles/R1.sql', 'users/U1.sql',
    ]);
  });

  test('writes one file per domain/exception/role/user under their own folder', function () {
    const files = buildProjectFiles(baseInput({
      domains: [{ name: 'D_AGE', type: 'INTEGER', length: 4, notNull: false }],
      exceptions: [{ name: 'EXC_1', message: 'bad thing' }],
      roles: [{ name: 'APP_ROLE' }],
      users: [{ name: 'JOHN_DOE' }],
    }));
    assert.ok(files.some(f => f.path === 'domains/D_AGE.sql'));
    assert.ok(files.some(f => f.path === 'exceptions/EXC_1.sql'));
    assert.ok(files.some(f => f.path === 'roles/APP_ROLE.sql'));
    assert.ok(files.some(f => f.path === 'users/JOHN_DOE.sql'));
  });
});

suite('buildProjectFiles() — Firebird 6 schema names', function () {
  const table = (name: string, displayName?: string) => ({
    name,
    ...(displayName ? { displayName } : {}),
    columns: [{ name: 'ID', type: 'INTEGER', length: 4, notNull: true, isPrimaryKey: true }],
  });
  const input = (tables: any[]) => ({
    graph: { tables, relationships: [] },
    views: [], procedures: [], triggers: [], generators: [], domains: [], roles: [], exceptions: [], users: [],
    pkConstraintNames: {},
  }) as any;

  test('a default-schema table keeps its short file name, so existing projects do not churn', function () {
    const files = buildProjectFiles(input([table('PUBLIC.ORDERS', 'ORDERS')]));
    const tableFile = files.find(f => f.path.startsWith('tables/'))!;
    assert.strictEqual(tableFile.path, 'tables/ORDERS.sql');
  });

  test('but its DDL is qualified, because that is what has to be unambiguous', function () {
    const files = buildProjectFiles(input([table('PUBLIC.ORDERS', 'ORDERS')]));
    const tableFile = files.find(f => f.path.startsWith('tables/'))!;
    assert.ok(tableFile.content.includes('CREATE TABLE PUBLIC.ORDERS'), tableFile.content);
  });

  test('a second schema gets its own file rather than overwriting the first', function () {
    const files = buildProjectFiles(input([table('PUBLIC.ORDERS', 'ORDERS'), table('SALES.ORDERS')]));
    const paths = files.filter(f => f.path.startsWith('tables/')).map(f => f.path).sort();
    assert.deepStrictEqual(paths, ['tables/ORDERS.sql', 'tables/SALES.ORDERS.sql']);
  });

  test('a pre-Firebird-6 graph is unaffected', function () {
    const files = buildProjectFiles(input([table('ORDERS')]));
    assert.strictEqual(files.find(f => f.path.startsWith('tables/'))!.path, 'tables/ORDERS.sql');
  });
});

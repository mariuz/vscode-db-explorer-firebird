import * as assert from 'assert';
import {
  getProcedureBodyQuery,
  getTriggerBodyQuery,
  getViewDefinitionQuery,
  getAllProcedureSourcesQuery,
  getAllProcedureParametersQuery,
  getAllTriggerSourcesQuery,
  getAllViewSourcesQuery,
  getPrimaryKeyColumnsQuery,
  getAllPrimaryKeyConstraintNamesQuery,
  getSchemaColumnsQuery,
  getForeignKeysQuery,
  MAX_SOURCE_CAST_LENGTH,
  createGeneratorQuery,
  generatorCurrentValueQuery,
  createViewScaffold,
  createProcedureScaffold,
  createTriggerScaffold,
  createDomainScaffold,
  alterDomainScaffold,
  profilerActivityQuery,
  getObjectPrivilegesQuery,
  killAttachmentQuery,
  rollbackTransactionQuery,
  tableInfoQuery,
  getTablesQuery,
  selectAllRecordsQuery,
  getViewsQuery,
  viewColumnsQuery,
  getStoredProceduresQuery,
  getTriggersQuery,
  getGeneratorsQuery,
  getDomainsQuery,
  getExceptionsQuery,
  procedureParametersQuery,
  fieldsQuery,
  getSchemasQuery,
  createSchemaQuery,
  dropSchemaQuery,
  setSearchPathQuery,
  alterSchemaQuery} from '../shared/queries';

// ── Source-fetching queries (procedure/trigger/view "edit source") ────────────
//
// Regression coverage for "SQL error code = -204, Data type unknown,
// Implementation limit exceeded, COLUMN" — these queries used to CAST the
// BLOB source column to VARCHAR(32000) with no explicit character set. Since
// node-firebird's default connection lc_ctype is UTF8 (up to 4 bytes/char),
// that CAST needed up to 128000 bytes, well over Firebird's 32767-byte column
// limit, so it always failed. The fix pins CHARACTER SET UTF8 explicitly (so
// the byte budget doesn't depend on whatever charset the connection
// negotiated) and sizes the VARCHAR to fit under it.

suite('getProcedureBodyQuery / getTriggerBodyQuery / getViewDefinitionQuery', function () {

  test('getProcedureBodyQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getProcedureBodyQuery('MY_PROC');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('getTriggerBodyQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getTriggerBodyQuery('MY_TRIGGER');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('getViewDefinitionQuery casts with an explicit CHARACTER SET UTF8', function () {
    const sql = getViewDefinitionQuery('MY_VIEW');
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('none of the source queries fall back to the old unqualified VARCHAR(32000) cast', function () {
    for (const sql of [getProcedureBodyQuery('P'), getTriggerBodyQuery('T'), getViewDefinitionQuery('V')]) {
      assert.ok(!/VARCHAR\(32000\)\s*\)/.test(sql), `still using an unqualified VARCHAR(32000) cast: ${sql}`);
    }
  });

  test('getProcedureBodyQuery filters by the given procedure name', function () {
    assert.ok(getProcedureBodyQuery("MY_PROC").includes("= 'MY_PROC'"));
  });

  test('getTriggerBodyQuery filters by the given trigger name', function () {
    assert.ok(getTriggerBodyQuery("MY_TRIGGER").includes("= 'MY_TRIGGER'"));
  });

  test('getViewDefinitionQuery filters by the given view name', function () {
    assert.ok(getViewDefinitionQuery("MY_VIEW").includes("= 'MY_VIEW'"));
  });
});

// ── getAllProcedureSourcesQuery / getAllTriggerSourcesQuery / getAllViewSourcesQuery ──────────
//
// The "all objects at once" counterparts of the single-name source queries above, used by the
// Database Projects Extract command so it fetches every procedure/trigger/view's source in one
// round trip instead of one query per object.

suite('getAllProcedureSourcesQuery / getAllTriggerSourcesQuery / getAllViewSourcesQuery', function () {
  test('all three cast with an explicit CHARACTER SET UTF8, same as the single-name versions', function () {
    for (const sql of [getAllProcedureSourcesQuery(), getAllTriggerSourcesQuery(), getAllViewSourcesQuery()]) {
      assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
    }
  });

  test('all three exclude system objects', function () {
    assert.ok(getAllProcedureSourcesQuery().includes('RDB$SYSTEM_FLAG'));
    assert.ok(getAllTriggerSourcesQuery().includes('RDB$SYSTEM_FLAG'));
    assert.ok(getAllViewSourcesQuery().includes('RDB$SYSTEM_FLAG'));
  });

  test('getAllViewSourcesQuery filters to actual views (RDB$VIEW_BLR IS NOT NULL)', function () {
    assert.ok(getAllViewSourcesQuery().includes('RDB$VIEW_BLR IS NOT NULL'));
  });

  test('getAllTriggerSourcesQuery normalizes INACTIVE to 0/1', function () {
    assert.ok(getAllTriggerSourcesQuery().includes('CASE WHEN RDB$TRIGGER_INACTIVE = 1 THEN 1 ELSE 0 END AS INACTIVE'));
  });

  test('none fetch just one named object (no name filter, unlike the single-object queries)', function () {
    for (const sql of [getAllProcedureSourcesQuery(), getAllTriggerSourcesQuery(), getAllViewSourcesQuery()]) {
      assert.ok(!/TRIM\([^)]+\)\s*=\s*'/.test(sql), `expected no name filter: ${sql}`);
    }
  });
});

// ── getAllProcedureParametersQuery ─────────────────────────────────────────────
//
// Needed to reconstruct a parameterized procedure's DDL, since RDB$PROCEDURE_SOURCE excludes the
// parameter list/RETURNS clause entirely (confirmed directly against a live server).

suite('getAllProcedureParametersQuery', function () {
  test('joins RDB$PROCEDURE_PARAMETERS to RDB$FIELDS via RDB$FIELD_SOURCE', function () {
    const sql = getAllProcedureParametersQuery();
    assert.ok(sql.includes('FROM RDB$PROCEDURE_PARAMETERS'), sql);
    assert.ok(sql.includes('pp.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME'), sql);
  });

  test('selects NUMERIC/DECIMAL precision/scale alongside the bare field type', function () {
    const sql = getAllProcedureParametersQuery();
    assert.ok(sql.includes('RDB$FIELD_SUB_TYPE'), sql);
    assert.ok(sql.includes('RDB$FIELD_PRECISION'), sql);
    assert.ok(sql.includes('RDB$FIELD_SCALE'), sql);
  });

  test('excludes system procedures\' parameters', function () {
    assert.ok(getAllProcedureParametersQuery().includes('RDB$SYSTEM_FLAG'));
  });

  test('orders by procedure, then parameter type (input before output), then declaration order', function () {
    assert.ok(getAllProcedureParametersQuery().includes('ORDER BY pp.RDB$PROCEDURE_NAME, pp.RDB$PARAMETER_TYPE, pp.RDB$PARAMETER_NUMBER'));
  });
});

// ── getPrimaryKeyColumnsQuery ──────────────────────────────────────────────────
//
// Used by the editable results grid to target UPDATE/DELETE at a single row.

suite('getPrimaryKeyColumnsQuery', function () {

  test('filters by the given table name', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes("= 'PRODUCTS'"));
  });

  test('filters constraints down to PRIMARY KEY', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"));
  });

  test('orders by field position so a composite key comes back in key order', function () {
    assert.ok(getPrimaryKeyColumnsQuery('PRODUCTS').includes('ORDER BY s.RDB$FIELD_POSITION'));
  });
});

// ── getAllPrimaryKeyConstraintNamesQuery ──────────────────────────────────────
//
// Used by the Schema Designer to DROP CONSTRAINT before adding a new primary key when a table's
// set of PK columns changes — one round trip for every table's PK constraint name at once.

suite('getAllPrimaryKeyConstraintNamesQuery', function () {
  const sql = getAllPrimaryKeyConstraintNamesQuery();

  test('takes no parameters — it covers every table in one query', function () {
    assert.strictEqual(getAllPrimaryKeyConstraintNamesQuery.length, 0);
  });

  test('filters constraints down to PRIMARY KEY', function () {
    assert.ok(sql.includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"), sql);
  });

  test('selects both the table name and the constraint name', function () {
    assert.ok(sql.includes('TABLE_NAME'), sql);
    assert.ok(sql.includes('CONSTRAINT_NAME'), sql);
  });
});

// ── getSchemaColumnsQuery — default value column ──────────────────────────────

suite('getSchemaColumnsQuery default value column', function () {
  const sql = getSchemaColumnsQuery();

  test('casts the default source with an explicit CHARACTER SET UTF8', function () {
    assert.ok(sql.includes('CAST(r.RDB$DEFAULT_SOURCE AS VARCHAR(100) CHARACTER SET UTF8) AS DFLT_VALUE'), sql);
  });
});

// ── getSchemaColumnsQuery — NUMERIC/DECIMAL fidelity ───────────────────────────
//
// Regression coverage for the "a NUMERIC(9,2) column round-trips as plain INTEGER" gap: this
// query used to select only the simplified type name + length, with nothing to distinguish a
// NUMERIC/DECIMAL column from its underlying INTEGER/BIGINT/DOUBLE storage type.

suite('getSchemaColumnsQuery NUMERIC/DECIMAL columns', function () {
  const sql = getSchemaColumnsQuery();

  test('selects RDB$FIELD_SUB_TYPE/PRECISION/SCALE from the already-joined RDB$FIELDS table', function () {
    assert.ok(sql.includes('f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE'), sql);
    assert.ok(sql.includes('f.RDB$FIELD_PRECISION AS FIELD_PRECISION'), sql);
    assert.ok(sql.includes('f.RDB$FIELD_SCALE AS FIELD_SCALE'), sql);
  });
});

// ── getSchemaColumnsQuery / getForeignKeysQuery ─────────────────────────────────
//
// Used by the schema visualizer to build the whole database's table/column/
// foreign-key graph in two queries instead of one round trip per table.

suite('getSchemaColumnsQuery', function () {
  const sql = getSchemaColumnsQuery();

  test('takes no parameters — it covers every table in one query', function () {
    assert.strictEqual(typeof getSchemaColumnsQuery, 'function');
    assert.strictEqual(getSchemaColumnsQuery.length, 0);
  });

  test('excludes views (RDB$VIEW_BLR IS NULL)', function () {
    assert.ok(sql.includes('rel.RDB$VIEW_BLR IS NULL'), sql);
  });

  test('excludes system tables', function () {
    assert.ok(sql.includes('RDB$SYSTEM_FLAG'), sql);
  });

  test('flags primary key columns', function () {
    assert.ok(sql.includes('IS_PRIMARY_KEY'), sql);
    assert.ok(sql.includes("RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"), sql);
  });

  test('orders by table then field position so columns come back in declaration order', function () {
    assert.ok(sql.includes('ORDER BY TABLE_NAME, r.RDB$FIELD_POSITION'), sql);
  });
});

suite('getForeignKeysQuery', function () {
  const sql = getForeignKeysQuery();

  test('takes no parameters — it covers every relationship in one query', function () {
    assert.strictEqual(getForeignKeysQuery.length, 0);
  });

  test('joins through RDB$REF_CONSTRAINTS to find the referenced constraint', function () {
    assert.ok(sql.includes('RDB$REF_CONSTRAINTS'), sql);
  });

  test('pairs composite-key columns up by field position', function () {
    assert.ok(sql.includes('seg2.RDB$FIELD_POSITION = seg.RDB$FIELD_POSITION'), sql);
  });

  test('selects both the local and referenced table/column names', function () {
    ['TABLE_NAME', 'COLUMN_NAME', 'REF_TABLE_NAME', 'REF_COLUMN_NAME'].forEach(col => {
      assert.ok(sql.includes(col), `expected ${col} in: ${sql}`);
    });
  });
});

// ── "Create new object" scaffolds/queries ─────────────────────────────────────

suite('createGeneratorQuery', function () {
  test('produces a CREATE SEQUENCE statement', function () {
    assert.strictEqual(createGeneratorQuery('GEN_CUSTOMER_ID'), 'CREATE SEQUENCE GEN_CUSTOMER_ID;');
  });

  test('rejects an unsafe generator name instead of interpolating it unescaped', function () {
    assert.throws(() => createGeneratorQuery('BAD; DROP TABLE X'), /Invalid generator name/);
  });
});

suite('generatorCurrentValueQuery', function () {
  test('reads the current value via GEN_ID(name, 0), never advancing it', function () {
    assert.strictEqual(
      generatorCurrentValueQuery('GEN_CUSTOMER_ID'),
      'SELECT GEN_ID(GEN_CUSTOMER_ID, 0) AS CURRENT_VALUE FROM RDB$DATABASE;'
    );
  });

  test('rejects an unsafe generator name instead of interpolating it unescaped', function () {
    assert.throws(() => generatorCurrentValueQuery('BAD; DROP TABLE X'), /Invalid generator name/);
  });
});

suite('getObjectPrivilegesQuery', function () {
  test('reads RDB$USER_PRIVILEGES filtered by object name', function () {
    const sql = getObjectPrivilegesQuery('CUSTOMERS');
    assert.ok(sql.includes('FROM RDB$USER_PRIVILEGES'), sql);
    assert.ok(sql.includes("TRIM(p.RDB$RELATION_NAME) = 'CUSTOMERS'"), sql);
  });

  test('maps single-letter privilege codes to friendly names', function () {
    const sql = getObjectPrivilegesQuery('CUSTOMERS');
    assert.ok(sql.includes("WHEN 'S' THEN 'SELECT'"), sql);
    assert.ok(sql.includes("WHEN 'X' THEN 'EXECUTE'"), sql);
    assert.ok(sql.includes("WHEN 'M' THEN 'MEMBER OF'"), sql);
  });

  test('rejects an unsafe object name instead of interpolating it unescaped', function () {
    assert.throws(() => getObjectPrivilegesQuery('BAD; DROP TABLE X'), /Invalid object name/);
  });
});

suite('createViewScaffold / createProcedureScaffold / createTriggerScaffold', function () {
  test('createViewScaffold embeds the name in a CREATE VIEW statement', function () {
    const sql = createViewScaffold('ACTIVE_CUSTOMERS');
    assert.ok(sql.startsWith('CREATE VIEW ACTIVE_CUSTOMERS AS'), sql);
  });

  test('createViewScaffold rejects an unsafe view name', function () {
    assert.throws(() => createViewScaffold('BAD; DROP TABLE X'), /Invalid view name/);
  });

  test('createProcedureScaffold embeds the name in a CREATE PROCEDURE statement', function () {
    const sql = createProcedureScaffold('GET_ACTIVE_CUSTOMERS');
    assert.ok(sql.startsWith('CREATE PROCEDURE GET_ACTIVE_CUSTOMERS'), sql);
    assert.ok(sql.includes('BEGIN') && sql.includes('END'), sql);
  });

  test('createProcedureScaffold rejects an unsafe procedure name', function () {
    assert.throws(() => createProcedureScaffold('BAD; DROP TABLE X'), /Invalid procedure name/);
  });

  test('createTriggerScaffold embeds the name in a CREATE TRIGGER statement', function () {
    const sql = createTriggerScaffold('CUSTOMERS_BI');
    assert.ok(sql.startsWith('CREATE TRIGGER CUSTOMERS_BI'), sql);
    assert.ok(sql.includes('BEGIN') && sql.includes('END'), sql);
  });

  test('createTriggerScaffold rejects an unsafe trigger name', function () {
    assert.throws(() => createTriggerScaffold('BAD; DROP TABLE X'), /Invalid trigger name/);
  });
});

suite('createDomainScaffold / alterDomainScaffold', function () {
  test('createDomainScaffold embeds the name in a CREATE DOMAIN statement', function () {
    const sql = createDomainScaffold('D_EMAIL');
    assert.ok(sql.startsWith('CREATE DOMAIN D_EMAIL AS'), sql);
  });

  test('createDomainScaffold rejects an unsafe domain name', function () {
    assert.throws(() => createDomainScaffold('BAD; DROP TABLE X'), /Invalid domain name/);
  });

  test('alterDomainScaffold pre-fills the current type as a comment and an ALTER DOMAIN template', function () {
    const sql = alterDomainScaffold({ DOMAIN_NAME: 'D_EMAIL', DOMAIN_TYPE: 'VARCHAR', FIELD_LENGTH: 100, NOT_NULL: 1 });
    assert.ok(sql.includes('-- Current definition: D_EMAIL VARCHAR(100) NOT NULL'), sql);
    assert.ok(sql.includes('ALTER DOMAIN D_EMAIL TYPE VARCHAR(100);'), sql);
  });

  test('alterDomainScaffold omits NOT NULL when the domain allows nulls', function () {
    const sql = alterDomainScaffold({ DOMAIN_NAME: 'D_NOTES', DOMAIN_TYPE: 'VARCHAR', FIELD_LENGTH: 200, NOT_NULL: 0 });
    assert.ok(!sql.includes('NOT NULL'), sql);
  });

  test('alterDomainScaffold rejects an unsafe domain name', function () {
    assert.throws(() => alterDomainScaffold({ DOMAIN_NAME: 'BAD; DROP TABLE X', DOMAIN_TYPE: 'INTEGER' }), /Invalid domain name/);
  });
});

// ── profilerActivityQuery ──────────────────────────────────────────────────────
//
// Verified directly against a real Firebird 3.0 server before being written (see the query's
// own doc comment in queries.ts) — these tests just check the SQL shape, not live behavior.

suite('profilerActivityQuery', function () {
  const sql = profilerActivityQuery();

  test('takes no parameters — one query covers every connection', function () {
    assert.strictEqual(profilerActivityQuery.length, 0);
  });

  test('excludes the profiler\'s own dedicated connection', function () {
    assert.ok(sql.includes('a.MON$ATTACHMENT_ID <> CURRENT_CONNECTION'), sql);
  });

  test('excludes internal engine attachments with no remote address', function () {
    assert.ok(sql.includes('a.MON$REMOTE_ADDRESS IS NOT NULL'), sql);
  });

  test('scopes IO/record stats to the attachment-level stat group (1), not transaction/statement', function () {
    assert.ok(sql.includes('io.MON$STAT_GROUP = 1'), sql);
    assert.ok(sql.includes('rs.MON$STAT_GROUP = 1'), sql);
  });

  test('casts the active statement text with an explicit CHARACTER SET UTF8', function () {
    assert.ok(sql.includes(`VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8`), sql);
  });

  test('picks only the most recently started active statement/transaction per attachment', function () {
    assert.ok(sql.includes('MAX(MON$STATEMENT_ID)'), sql);
    assert.ok(sql.includes('WHERE MON$STATE = 1'), sql);
    assert.ok(sql.includes('MAX(MON$TRANSACTION_ID)'), sql);
  });

  // Live Profiler "Sessions" view (phase 5) — record lock waits/conflicts and transaction-level
  // fields, plus the database's oldest-active-transaction number for flagging the connection
  // most likely to be holding back garbage collection.

  test('includes record lock wait/conflict counters from the attachment-level stat row', function () {
    assert.ok(sql.includes('rs.MON$RECORD_WAITS AS RECORD_WAITS'), sql);
    assert.ok(sql.includes('rs.MON$RECORD_CONFLICTS AS RECORD_CONFLICTS'), sql);
  });

  test('includes transaction start time, lock timeout, auto-commit, and read-only flags', function () {
    assert.ok(sql.includes('tx.MON$TIMESTAMP AS TX_STARTED_AT'), sql);
    assert.ok(sql.includes('tx.MON$LOCK_TIMEOUT AS LOCK_TIMEOUT'), sql);
    assert.ok(sql.includes('tx.MON$AUTO_COMMIT AS TX_AUTO_COMMIT'), sql);
    assert.ok(sql.includes('tx.MON$READ_ONLY AS TX_READ_ONLY'), sql);
  });

  test('includes the database\'s oldest-active-transaction number via a scalar subquery', function () {
    assert.ok(sql.includes('(SELECT MON$OLDEST_ACTIVE FROM MON$DATABASE) AS DB_OLDEST_ACTIVE'), sql);
  });
});

// ── killAttachmentQuery / rollbackTransactionQuery ──────────────────────────────
//
// Live Profiler phase 3 (docs/roadmap/live-profiler.md) "Kill"/"Rollback" row actions.

suite('killAttachmentQuery / rollbackTransactionQuery', function () {

  test('killAttachmentQuery deletes the given attachment from MON$ATTACHMENTS', function () {
    const sql = killAttachmentQuery(42);
    assert.strictEqual(sql, 'DELETE FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = 42;');
  });

  test('killAttachmentQuery rejects a non-integer id rather than interpolating it unchecked', function () {
    assert.throws(() => killAttachmentQuery(1.5));
    assert.throws(() => killAttachmentQuery(NaN));
    assert.throws(() => killAttachmentQuery('42; DROP TABLE X' as any));
  });

  test('rollbackTransactionQuery deletes the given transaction from MON$TRANSACTIONS', function () {
    const sql = rollbackTransactionQuery(7);
    assert.strictEqual(sql, 'DELETE FROM MON$TRANSACTIONS WHERE MON$TRANSACTION_ID = 7;');
  });

  test('rollbackTransactionQuery rejects a non-integer id rather than interpolating it unchecked', function () {
    assert.throws(() => rollbackTransactionQuery(1.5));
    assert.throws(() => rollbackTransactionQuery(NaN));
    assert.throws(() => rollbackTransactionQuery('7; DROP TABLE X' as any));
  });
});

// ── tableInfoQuery ────────────────────────────────────────────────────────────
//
// Flat File Import Wizard "map onto an existing table" mode (docs/roadmap/flat-file-import-wizard.md
// phase 3) reads a target table's columns through this query — mapFirebirdFieldToSqlType()
// (src/shared/flat-file-parser.ts) needs its FIELD_TYPE mapping to actually recognize every type
// it might see, including RDB$FIELD_TYPE 23 (BOOLEAN), which this query didn't map at all before
// (fell through to 'UNKNOWN') — also used by the tree's own field listing, so this was a real gap
// beyond just the import wizard.

suite('tableInfoQuery', function () {
  const sql = tableInfoQuery('CUSTOMERS');

  test('filters to the given table name', function () {
    assert.ok(sql.includes("r.RDB$RELATION_NAME ='CUSTOMERS'"), sql);
  });

  test('maps RDB$FIELD_TYPE 23 to BOOLEAN', function () {
    assert.ok(sql.includes("WHEN 23  THEN 'BOOLEAN'"), sql);
  });

  test('still maps every previously-supported type (unaffected by the BOOLEAN addition)', function () {
    for (const mapping of [
      "WHEN 261 THEN 'BLOB'", "WHEN 14  THEN 'CHAR'", "WHEN 40  THEN 'CSTRING'",
      "WHEN 11  THEN 'D_FLOAT'", "WHEN 27  THEN 'DOUBLE'", "WHEN 10  THEN 'FLOAT'",
      "WHEN 16  THEN 'INT64'", "WHEN 8   THEN 'INTEGER'", "WHEN 9   THEN 'QUAD'",
      "WHEN 7   THEN 'SMALLINT'", "WHEN 12  THEN 'DATE'", "WHEN 13  THEN 'TIME'",
      "WHEN 35  THEN 'TIMESTAMP'", "WHEN 37  THEN 'VARCHAR'",
    ]) {
      assert.ok(sql.includes(mapping), `missing ${mapping}`);
    }
  });
});

// ── getTablesQuery ────────────────────────────────────────────────────────────

suite('getTablesQuery', function () {
  test('excludes views (RDB$VIEW_BLR IS NULL) and system tables', function () {
    const sql = getTablesQuery(0);
    assert.ok(sql.includes('RDB$VIEW_BLR IS NULL'), sql);
    assert.ok(sql.includes('RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0'), sql);
  });

  test('caps the result with FIRST <n> when a nonzero max is given', function () {
    const sql = getTablesQuery(50);
    assert.ok(sql.includes('SELECT FIRST 50'), sql);
  });

  test('omits FIRST entirely when max is 0 (no cap)', function () {
    const sql = getTablesQuery(0);
    assert.ok(!sql.includes('FIRST'), sql);
  });
});

suite('selectAllRecordsQuery() — the firebird.maxResultRows server-side cap', function () {
  test('no cap by default, so existing behaviour is unchanged', function () {
    assert.strictEqual(selectAllRecordsQuery('CUSTOMERS'), 'SELECT * FROM CUSTOMERS;');
  });

  test('a positive limit becomes a FIRST clause, which caps on the server', function () {
    assert.strictEqual(selectAllRecordsQuery('CUSTOMERS', 500), 'SELECT FIRST 500 * FROM CUSTOMERS;');
  });

  test('0 means no limit', function () {
    assert.strictEqual(selectAllRecordsQuery('CUSTOMERS', 0), 'SELECT * FROM CUSTOMERS;');
  });

  test('a negative or non-integer limit is ignored rather than emitted as broken SQL', function () {
    assert.strictEqual(selectAllRecordsQuery('T', -5), 'SELECT * FROM T;');
    assert.strictEqual(selectAllRecordsQuery('T', 1.5), 'SELECT * FROM T;');
    assert.strictEqual(selectAllRecordsQuery('T', NaN), 'SELECT * FROM T;');
  });
});

suite('getTablesQuery() — Firebird 6 schema awareness', function () {
  test('without schemas the SQL is unchanged, so a pre-6 server sees no difference', function () {
    const legacy = getTablesQuery(0);
    assert.ok(!legacy.includes('RDB$SCHEMA_NAME'), 'must not ask a pre-6 server for a column it does not have');
    assert.ok(legacy.includes('RDB$RELATION_NAME TABLE_NAME'));
    assert.strictEqual(getTablesQuery(0), getTablesQuery(0, false));
  });

  test('with schemas it selects the schema alongside the name', function () {
    const fb6 = getTablesQuery(0, true);
    assert.ok(fb6.includes('RDB$SCHEMA_NAME SCHEMA_NAME'));
    assert.ok(fb6.includes('RDB$RELATION_NAME TABLE_NAME'));
    assert.ok(fb6.includes('ORDER BY 1, 2'), 'schema first, so same-named tables sit together');
  });

  test('the row cap still applies in both forms', function () {
    assert.ok(getTablesQuery(10).includes('FIRST 10'));
    assert.ok(getTablesQuery(10, true).includes('FIRST 10'));
    assert.ok(!getTablesQuery(0, true).includes('FIRST'));
  });
});

suite('tableInfoQuery() — Firebird 6 schema filtering', function () {
  test('without a schema the SQL is unchanged, so a pre-6 server sees no difference', function () {
    const legacy = tableInfoQuery('ORDERS');
    assert.ok(!legacy.includes('RDB$SCHEMA_NAME'), 'must not reference a column a pre-6 server does not have');
    assert.ok(legacy.includes("r.RDB$RELATION_NAME ='ORDERS'"));
  });

  test('a schema becomes a predicate on the relation, which is what stops the column merge', function () {
    // Verified live: without this, a lookup for ORDERS against a database holding both
    // SALES.ORDERS (ID, TOTAL) and PUBLIC.ORDERS (ID, NOTE) returned ID, NOTE, TOTAL — a table
    // that does not exist. With it, each returns only its own columns.
    const scoped = tableInfoQuery('ORDERS', 'SALES');
    assert.ok(scoped.includes("r.RDB$SCHEMA_NAME = 'SALES'"));
  });

  test('the index join is scoped to the same schema, not just the relation name', function () {
    // RDB$INDICES carries RDB$SCHEMA_NAME on Firebird 6 (confirmed against a live server), so
    // joining on the relation name alone would attach another schema's indexes to these columns.
    assert.ok(tableInfoQuery('ORDERS', 'SALES').includes('i.RDB$SCHEMA_NAME = r.RDB$SCHEMA_NAME'));
  });

  test('an empty or whitespace schema is treated as absent rather than emitted as a broken predicate', function () {
    assert.ok(!tableInfoQuery('ORDERS', '').includes('RDB$SCHEMA_NAME'));
    assert.ok(!tableInfoQuery('ORDERS', '   ').includes('RDB$SCHEMA_NAME'));
  });
});

suite('view queries — Firebird 6 schema awareness', function () {
  test('getViewsQuery() is unchanged without schemas and selects one with them', function () {
    assert.ok(!getViewsQuery().includes('RDB$SCHEMA_NAME'));
    assert.strictEqual(getViewsQuery(), getViewsQuery(false));
    const fb6 = getViewsQuery(true);
    assert.ok(fb6.includes('RDB$SCHEMA_NAME'));
    assert.ok(fb6.includes('ORDER BY 1, 2'));
  });

  test('viewColumnsQuery() scopes to a schema when given one', function () {
    // Verified live: without this, a lookup for a view named ACTIVE existing in two schemas
    // returned ID, ID, TOTAL, NOTE — duplicated and merged.
    assert.ok(viewColumnsQuery('ACTIVE', 'SALES').includes("r.RDB$SCHEMA_NAME = 'SALES'"));
    assert.ok(!viewColumnsQuery('ACTIVE').includes('RDB$SCHEMA_NAME'));
  });

  test('getViewDefinitionQuery() scopes to a schema, since its caller reads row 0', function () {
    // Two same-named views would otherwise return two rows and the caller would show — and let
    // you edit — whichever came first.
    assert.ok(getViewDefinitionQuery('ACTIVE', 'SALES').includes("RDB$SCHEMA_NAME = 'SALES'"));
    assert.ok(!getViewDefinitionQuery('ACTIVE').includes('RDB$SCHEMA_NAME'));
  });
});

suite('remaining object categories — Firebird 6 schema awareness', function () {
  const listings: [string, (withSchemas?: boolean) => string][] = [
    ['procedures', getStoredProceduresQuery],
    ['triggers', getTriggersQuery],
    ['generators', getGeneratorsQuery],
    ['domains', getDomainsQuery],
    ['exceptions', getExceptionsQuery],
  ];

  for (const [label, build] of listings) {
    test(`${label}: unchanged without schemas, schema-carrying with them`, function () {
      assert.ok(!build().includes('RDB$SCHEMA_NAME'), `${label} must not reference the column on a pre-6 server`);
      assert.strictEqual(build(), build(false));
      assert.ok(build(true).includes('RDB$SCHEMA_NAME'), `${label} should select the schema on Firebird 6`);
    });
  }

  test('procedureParametersQuery() scopes to a schema', function () {
    // Verified live: without this, TOTALS existing in two schemas returned both procedures'
    // parameters (N, M) as if one procedure had both.
    assert.ok(procedureParametersQuery('TOTALS', 'SALES').includes("pp.RDB$SCHEMA_NAME = 'SALES'"));
    assert.ok(!procedureParametersQuery('TOTALS').includes('RDB$SCHEMA_NAME'));
  });

  test('getProcedureBodyQuery() scopes to a schema, since its caller reads row 0', function () {
    assert.ok(getProcedureBodyQuery('TOTALS', 'SALES').includes("RDB$SCHEMA_NAME = 'SALES'"));
    assert.ok(!getProcedureBodyQuery('TOTALS').includes('RDB$SCHEMA_NAME'));
  });
});

suite('getForeignKeysQuery() — Firebird 6 schema scoping', function () {
  test('unchanged without schemas', function () {
    assert.ok(!getForeignKeysQuery().includes('RDB$SCHEMA_NAME'));
    assert.strictEqual(getForeignKeysQuery(), getForeignKeysQuery(false));
  });

  test('scopes every join, not just the first', function () {
    // Verified live: with the same constraint name AND the same index name present in two
    // schemas, joining on names alone returned an 8-row cross product for two foreign keys.
    // Scoping all four joins returns exactly 2.
    const fb6 = getForeignKeysQuery(true);
    assert.ok(fb6.includes('rc.RDB$SCHEMA_NAME = refc.RDB$SCHEMA_NAME'), 'constraint join');
    assert.ok(fb6.includes('seg.RDB$SCHEMA_NAME = rc.RDB$SCHEMA_NAME'), 'index segment join');
    assert.ok(fb6.includes('seg2.RDB$SCHEMA_NAME = rc2.RDB$SCHEMA_NAME'), 'referenced index segment join');
  });

  test('joins the referenced side through RDB$CONST_SCHEMA_NAME_UQ', function () {
    // A foreign key may reference a table in a *different* schema, so the referenced constraint's
    // schema comes from RDB$REF_CONSTRAINTS rather than being assumed to match the FK's own.
    assert.ok(getForeignKeysQuery(true).includes('rc2.RDB$SCHEMA_NAME = refc.RDB$CONST_SCHEMA_NAME_UQ'));
  });

  test('exposes both sides\' schemas so callers can qualify each independently', function () {
    const fb6 = getForeignKeysQuery(true);
    assert.ok(fb6.includes('AS SCHEMA_NAME'));
    assert.ok(fb6.includes('AS REF_SCHEMA_NAME'));
  });
});

suite('getSchemaColumnsQuery() — Firebird 6 schema scoping', function () {
  test('unchanged without schemas', function () {
    assert.ok(!getSchemaColumnsQuery().includes('RDB$SCHEMA_NAME'));
    assert.strictEqual(getSchemaColumnsQuery(), getSchemaColumnsQuery(false));
  });

  test('scopes every join, not just the relation one', function () {
    // Verified live: without these, one table's four columns came back as sixteen rows, because
    // the relation, domain and primary-key joins all match names that repeat per schema.
    const fb6 = getSchemaColumnsQuery(true);
    assert.ok(fb6.includes('rel.RDB$SCHEMA_NAME = r.RDB$SCHEMA_NAME'), 'relation join');
    assert.ok(fb6.includes('f.RDB$SCHEMA_NAME = r.RDB$SCHEMA_NAME'), 'domain join');
    assert.ok(fb6.includes('s.RDB$SCHEMA_NAME = rc.RDB$SCHEMA_NAME'), 'primary-key index join');
    assert.ok(fb6.includes('pk.RDB$SCHEMA_NAME = r.RDB$SCHEMA_NAME'), 'primary-key outer join');
  });
});

suite('fieldsQuery() — Firebird 6 schema awareness', function () {
  test('unchanged without schemas', function () {
    assert.ok(!fieldsQuery(['T']).includes('RDB$SCHEMA_NAME'));
    assert.strictEqual(fieldsQuery(['T']), fieldsQuery(['T'], false));
  });

  test('with schemas it returns the owning schema alongside each column', function () {
    // schema-diff keys its snapshot by schema + table; without the column, two same-named tables
    // collapse into one entry whose columns are the union of both.
    const fb6 = fieldsQuery(['T'], true);
    assert.ok(fb6.includes('RDB$SCHEMA_NAME'));
    assert.ok(fb6.includes('GROUP BY SCHEMA_NAME,'), fb6);
  });

  test('the name match stays name-only, by design', function () {
    // Callers pass bare relation names and key by schema + name themselves, which is simpler than
    // threading qualified names through an IN list.
    assert.ok(fieldsQuery(['ORDERS'], true).includes("IN ('ORDERS')"));
  });
});

suite('schema lifecycle queries (Firebird 6)', function () {
  test('getSchemasQuery() hides SYSTEM unless asked', function () {
    // SYSTEM holds all RDB$/MON$ metadata, is appended to every search path implicitly, and only
    // index operations may be performed on it — listing it by default would invite a drop attempt.
    assert.ok(getSchemasQuery().includes('RDB$SYSTEM_FLAG'));
    assert.ok(!getSchemasQuery(true).includes('RDB$SYSTEM_FLAG IS NULL'));
  });

  test('CREATE and DROP name the schema, nothing more', function () {
    assert.strictEqual(createSchemaQuery('SALES'), 'CREATE SCHEMA SALES;');
    assert.strictEqual(dropSchemaQuery('SALES'), 'DROP SCHEMA SALES;');
  });

  test('both refuse anything that is not a plain identifier', function () {
    // These interpolate straight into DDL, so the guard matters more here than most places.
    for (const bad of ['SALES; DROP DATABASE', "SALES'", 'SALES SCHEMA', '']) {
      assert.throws(() => createSchemaQuery(bad), `create accepted ${JSON.stringify(bad)}`);
      assert.throws(() => dropSchemaQuery(bad), `drop accepted ${JSON.stringify(bad)}`);
    }
  });
});

suite('setSearchPathQuery() (Firebird 6)', function () {
  test('names the schema, and not SYSTEM', function () {
    // Firebird appends SYSTEM to every search path itself. Listing it would suggest the caller
    // controls something they do not — verified live: after SET SEARCH_PATH TO SALES, the session
    // reports "SALES", "SYSTEM".
    assert.strictEqual(setSearchPathQuery('SALES'), 'SET SEARCH_PATH TO SALES;');
  });

  test('refuses anything that is not a plain identifier', function () {
    for (const bad of ['SALES, PUBLIC', 'SALES; DROP DATABASE', "SALES'", '']) {
      assert.throws(() => setSearchPathQuery(bad), `accepted ${JSON.stringify(bad)}`);
    }
  });
});

suite('alterSchemaQuery() (Firebird 6)', function () {
  test('uses SET DEFAULT, which is what the server actually accepts', function () {
    // Established live, not from documentation: `ALTER SCHEMA S DEFAULT SQL SECURITY INVOKER` —
    // the form CREATE SCHEMA uses — is rejected with "Token unknown ... DEFAULT", and so is the
    // bare `SQL SECURITY` form.
    assert.strictEqual(
      alterSchemaQuery('SALES', { sqlSecurity: 'INVOKER' }),
      'ALTER SCHEMA SALES SET DEFAULT SQL SECURITY INVOKER;'
    );
    assert.strictEqual(
      alterSchemaQuery('SALES', { characterSet: 'UTF8' }),
      'ALTER SCHEMA SALES SET DEFAULT CHARACTER SET UTF8;'
    );
  });

  test('rejects an SQL security value that is neither DEFINER nor INVOKER', function () {
    assert.throws(() => alterSchemaQuery('SALES', { sqlSecurity: 'ANYONE' as any }));
  });

  test('guards both identifiers, since each is interpolated into DDL', function () {
    assert.throws(() => alterSchemaQuery('SALES; DROP DATABASE', { characterSet: 'UTF8' }));
    assert.throws(() => alterSchemaQuery('SALES', { characterSet: 'UTF8; DROP DATABASE' }));
  });
});

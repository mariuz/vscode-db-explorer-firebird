/**
 * Unit tests for renderKnexMigration() (src/schema-diff/knex-migration.ts).
 *
 * Strategy: the function is a pure string builder — tests drive it with hand-crafted PublishDiff
 * objects (the same shape diffProjects() produces) and assert on key substrings of the output.
 * No database, no Knex runtime, no VS Code API required.
 */

import * as assert from 'assert';
import { renderKnexMigration, knexMigrationTimestamp } from '../schema-diff/knex-migration';
import { PublishDiff } from '../database-projects/publish-model';
import { SchemaTable, SchemaColumn, SchemaRelationship } from '../schema-designer/schema-graph';
import { DomainSource, ViewSource, ProcedureSource, TriggerSource } from '../database-projects/project-model';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXED_TS = '2025-06-01 08:00:00 UTC';

function emptyDiff(): PublishDiff {
  return {
    newTables: [],
    droppedTables: [],
    modifiedTables: [],
    newForeignKeys: [],
    droppedForeignKeys: [],
    newDomains: [],
    changedDomains: [],
    droppedDomains: [],
    newViews: [],
    changedViews: [],
    droppedViews: [],
    newProcedures: [],
    changedProcedures: [],
    droppedProcedures: [],
    newTriggers: [],
    changedTriggers: [],
    droppedTriggers: [],
    newGenerators: [],
    droppedGenerators: [],
    newExceptions: [],
    changedExceptions: [],
    droppedExceptions: [],
    newRoles: [],
    droppedRoles: [],
    newUsers: [],
    droppedUsers: [],
  };
}

function col(name: string, type: string, length = 0, notNull = false, isPrimaryKey = false): SchemaColumn {
  return { name, type, length, notNull, isPrimaryKey };
}

function table(name: string, columns: SchemaColumn[]): SchemaTable {
  return { name, columns };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

suite('Knex Migration Generator – renderKnexMigration()', function () {

  // ── File structure ─────────────────────────────────────────────────────────

  test('empty diff produces a valid JS file with "no schema changes" comment', function () {
    const out = renderKnexMigration(emptyDiff(), 'DB_A', 'DB_B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('exports.up'), 'Should have exports.up');
    assert.ok(out.includes('exports.down'), 'Should have exports.down');
    assert.ok(out.includes('No schema changes'), 'Should say no changes when diff is empty');
  });

  test('TypeScript output uses import type and export async function syntax', function () {
    const out = renderKnexMigration(emptyDiff(), 'A', 'B', { language: 'ts', generatedAt: FIXED_TS });
    assert.ok(out.includes("import type { Knex }"), 'Should import Knex type');
    assert.ok(out.includes('export async function up'), 'Should use export async function up');
    assert.ok(out.includes('export async function down'), 'Should use export async function down');
    assert.ok(!out.includes('exports.up'), 'Should NOT use CommonJS exports.up in TS mode');
  });

  test('file header contains source, target and timestamp', function () {
    const out = renderKnexMigration(emptyDiff(), 'prod-db', 'staging-db', { generatedAt: FIXED_TS });
    assert.ok(out.includes('prod-db'), 'Source label should appear in header');
    assert.ok(out.includes('staging-db'), 'Target label should appear in header');
    assert.ok(out.includes(FIXED_TS), 'Timestamp should appear in header');
  });

  test('file header mentions knex-firebird-dialect in the usage note', function () {
    const out = renderKnexMigration(emptyDiff(), 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('knex-firebird-dialect'), 'Usage note should mention knex-firebird-dialect');
    assert.ok(out.includes('knex migrate:latest'), 'Usage note should show the CLI command');
  });

  // ── CREATE TABLE ───────────────────────────────────────────────────────────

  test('new VARCHAR column uses table.string()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('CUSTOMERS', [col('NAME', 'VARCHAR', 100)])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("createTable('CUSTOMERS'"), 'Should call createTable');
    assert.ok(out.includes("table.string('NAME', 100)"), 'VARCHAR should use table.string()');
  });

  test('new INTEGER column uses table.integer()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('ORDERS', [col('ID', 'INTEGER')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.integer('ID')"), 'INTEGER should use table.integer()');
  });

  test('new BIGINT (INT64) column uses table.bigInteger()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('SEQ', 'INT64')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.bigInteger('SEQ')"), 'INT64 should use table.bigInteger()');
  });

  test('new TIMESTAMP column uses table.timestamp()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('CREATED_AT', 'TIMESTAMP')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.timestamp('CREATED_AT'"), 'TIMESTAMP should use table.timestamp()');
  });

  test('new BLOB column uses table.binary()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('DATA', 'BLOB')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.binary('DATA')"), 'BLOB should use table.binary()');
  });

  test('NUMERIC column uses table.decimal() with precision and scale', function () {
    const numericCol: SchemaColumn = {
      name: 'PRICE', type: 'NUMERIC', length: 0, notNull: false, isPrimaryKey: false,
      subType: 1, precision: 10, scale: -2,
    };
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('PRODUCTS', [numericCol])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.decimal('PRICE', 10, 2)"), 'NUMERIC(10,2) should use table.decimal()');
  });

  test('NOT NULL column chains .notNullable()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('CODE', 'VARCHAR', 10, true)])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('.notNullable()'), 'NOT NULL column should chain .notNullable()');
  });

  test('nullable column chains .nullable()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('NOTES', 'VARCHAR', 200, false)])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('.nullable()'), 'Nullable column should chain .nullable()');
  });

  test('single-column PK uses .primary() chain', function () {
    const pkCol = col('ID', 'INTEGER', 0, true, true);
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [pkCol])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('.primary()'), 'Single-column PK should chain .primary()');
  });

  test('composite PK emits table.primary([...]) rather than per-column .primary()', function () {
    const pk1 = col('ORDER_ID', 'INTEGER', 0, true, true);
    const pk2 = col('LINE_NO', 'INTEGER', 0, true, true);
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('ORDER_LINES', [pk1, pk2])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.primary(["), 'Composite PK should use table.primary([...])');
    assert.ok(out.includes("'ORDER_ID'") && out.includes("'LINE_NO'"), 'Both PK columns should appear');
  });

  test('default value uses .defaultTo(knex.raw(...))', function () {
    const colWithDefault: SchemaColumn = {
      name: 'STATUS', type: 'VARCHAR', length: 20, notNull: false, isPrimaryKey: false,
      dflt: "'ACTIVE'",
    };
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [colWithDefault])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('.defaultTo(knex.raw('), 'Default value should use .defaultTo(knex.raw(...))');
  });

  // ── DROP TABLE (opt-in) ────────────────────────────────────────────────────

  test('dropped tables are NOT emitted by default (additive-only mode)', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedTables: ['OLD_TABLE'] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(!out.includes('dropTableIfExists'), 'Drops should be suppressed when includeDrops=false');
  });

  test('dropped tables ARE emitted when includeDrops=true', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedTables: ['LEGACY_TABLE'] };
    const out = renderKnexMigration(diff, 'A', 'B', { includeDrops: true, generatedAt: FIXED_TS });
    assert.ok(out.includes("dropTableIfExists('LEGACY_TABLE')"), 'Drop should appear when includeDrops=true');
  });

  // ── ALTER TABLE ────────────────────────────────────────────────────────────

  test('added column on existing table emits alterTable with new column', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'CUSTOMERS',
        addedColumns: [col('EMAIL', 'VARCHAR', 255)],
        droppedColumns: [],
        changedColumns: [],
        pkChanged: false,
        newPkColumns: [],
      }],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("alterTable('CUSTOMERS'"), 'Should call alterTable');
    assert.ok(out.includes("table.string('EMAIL', 255)"), 'New column should be added');
  });

  test('dropped column on existing table emits table.dropColumn()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'ORDERS',
        addedColumns: [],
        droppedColumns: ['LEGACY_FIELD'],
        changedColumns: [],
        pkChanged: false,
        newPkColumns: [],
      }],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.dropColumn('LEGACY_FIELD')"), 'Dropped column should use table.dropColumn()');
  });

  test('modified column emits column builder with .alter()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'PRODUCTS',
        addedColumns: [],
        droppedColumns: [],
        changedColumns: [{
          name: 'DESCRIPTION',
          source: col('DESCRIPTION', 'VARCHAR', 500, false),
          target: col('DESCRIPTION', 'VARCHAR', 200, false),
        }],
        pkChanged: false,
        newPkColumns: [],
      }],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('.alter()'), 'Modified column should chain .alter()');
    assert.ok(out.includes("table.string('DESCRIPTION', 500)"), 'Modified column should use new type');
  });

  // ── Foreign keys ───────────────────────────────────────────────────────────

  test('new foreign key emits alterTable with table.foreign().references().inTable()', function () {
    const fk: SchemaRelationship = {
      constraintName: 'FK_ORDER_CUSTOMER',
      table: 'ORDERS',
      column: 'CUSTOMER_ID',
      refTable: 'CUSTOMERS',
      refColumn: 'ID',
    };
    const diff: PublishDiff = { ...emptyDiff(), newForeignKeys: [fk] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes("table.foreign('CUSTOMER_ID', 'FK_ORDER_CUSTOMER')"), 'FK declaration');
    assert.ok(out.includes(".references('ID')"), 'FK references column');
    assert.ok(out.includes(".inTable('CUSTOMERS')"), 'FK references table');
  });

  // ── Sequences / generators ─────────────────────────────────────────────────

  test('new generator emits CREATE SEQUENCE via knex.raw()', function () {
    const diff: PublishDiff = { ...emptyDiff(), newGenerators: ['GEN_ORDERS_ID'] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE SEQUENCE GEN_ORDERS_ID'), 'Generator should emit CREATE SEQUENCE');
    assert.ok(out.includes('knex.raw('), 'Sequence should use knex.raw()');
  });

  // ── Domains ────────────────────────────────────────────────────────────────

  test('new domain emits CREATE DOMAIN via knex.raw()', function () {
    const domain: DomainSource = {
      name: 'D_EMAIL', type: 'VARCHAR', length: 255, notNull: false,
    };
    const diff: PublishDiff = { ...emptyDiff(), newDomains: [domain] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE DOMAIN D_EMAIL'), 'Should emit CREATE DOMAIN');
  });

  // ── Views ──────────────────────────────────────────────────────────────────

  test('new view emits CREATE OR ALTER VIEW via knex.raw()', function () {
    const view: ViewSource = { name: 'V_ACTIVE_CUSTOMERS', source: 'SELECT * FROM CUSTOMERS WHERE ACTIVE = 1' };
    const diff: PublishDiff = { ...emptyDiff(), newViews: [view] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE OR ALTER VIEW V_ACTIVE_CUSTOMERS'), 'Should emit CREATE OR ALTER VIEW');
  });

  // ── Stored procedures ──────────────────────────────────────────────────────

  test('new procedure emits CREATE OR ALTER PROCEDURE via knex.raw()', function () {
    const proc: ProcedureSource = { name: 'SP_UPDATE_STATUS', source: 'AS BEGIN END' };
    const diff: PublishDiff = { ...emptyDiff(), newProcedures: [proc] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE OR ALTER PROCEDURE SP_UPDATE_STATUS'), 'Should emit CREATE OR ALTER PROCEDURE');
  });

  // ── Triggers ──────────────────────────────────────────────────────────────

  test('new trigger emits CREATE OR ALTER TRIGGER via knex.raw()', function () {
    const trigger: TriggerSource = {
      name: 'TR_BEFORE_INSERT', table: 'ORDERS',
      inactive: false, type: 1, source: 'AS BEGIN END',
    };
    const diff: PublishDiff = { ...emptyDiff(), newTriggers: [trigger] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE OR ALTER TRIGGER TR_BEFORE_INSERT'), 'Should emit CREATE OR ALTER TRIGGER');
  });

  // ── Drop opt-in for non-table objects ──────────────────────────────────────

  test('dropped generators NOT emitted without includeDrops', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedGenerators: ['GEN_OLD'] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(!out.includes('DROP SEQUENCE'), 'DROP SEQUENCE should not appear without includeDrops');
  });

  test('dropped generators ARE emitted with includeDrops=true', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedGenerators: ['GEN_OLD'] };
    const out = renderKnexMigration(diff, 'A', 'B', { includeDrops: true, generatedAt: FIXED_TS });
    assert.ok(out.includes('DROP SEQUENCE GEN_OLD'), 'DROP SEQUENCE should appear with includeDrops=true');
  });

  test('dropped views NOT emitted without includeDrops', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedViews: [{ name: 'V_OLD', source: '' }] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(!out.includes('DROP VIEW'), 'DROP VIEW should not appear without includeDrops');
  });

  test('dropped views ARE emitted with includeDrops=true', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedViews: [{ name: 'V_OLD', source: '' }] };
    const out = renderKnexMigration(diff, 'A', 'B', { includeDrops: true, generatedAt: FIXED_TS });
    assert.ok(out.includes('DROP VIEW V_OLD'), 'DROP VIEW should appear with includeDrops=true');
  });

  // ── Exceptions ────────────────────────────────────────────────────────────

  test('new exception emits CREATE OR ALTER EXCEPTION via knex.raw()', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newExceptions: [{ name: 'EX_NOT_FOUND', message: 'Record not found' }],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('CREATE OR ALTER EXCEPTION EX_NOT_FOUND'), 'Exception should be emitted');
    assert.ok(out.includes('Record not found'), 'Exception message should appear');
  });

  // ── Down stub ─────────────────────────────────────────────────────────────

  test('exports.down is always present (as a stub)', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('ID', 'INTEGER')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('exports.down'), 'exports.down stub should always be present');
    assert.ok(out.includes('TODO: implement rollback'), 'down stub should contain TODO comment');
  });

  // ── includeDrops hint ─────────────────────────────────────────────────────

  test('hint about includeDrops appears in header when there are suppressed drops', function () {
    const diff: PublishDiff = { ...emptyDiff(), droppedTables: ['OLD'] };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(out.includes('includeDrops=true'), 'Header should hint about includeDrops');
  });

  test('no includeDrops hint when there are no drops at all', function () {
    const diff: PublishDiff = {
      ...emptyDiff(),
      newTables: [table('T', [col('ID', 'INTEGER')])],
    };
    const out = renderKnexMigration(diff, 'A', 'B', { generatedAt: FIXED_TS });
    assert.ok(!out.includes('includeDrops=true'), 'No hint when nothing was suppressed');
  });
});

// ── knexMigrationTimestamp ─────────────────────────────────────────────────────

suite('Knex Migration Generator – knexMigrationTimestamp()', function () {

  test('returns exactly 14 digits', function () {
    const ts = knexMigrationTimestamp(new Date('2025-06-01T08:30:45.000Z'));
    assert.strictEqual(ts.length, 14, 'Timestamp must be exactly 14 characters');
    assert.ok(/^\d{14}$/.test(ts), 'Timestamp must be all digits');
  });

  test('encodes year, month, day, hour, minute, second in YYYYMMDDHHmmss order', function () {
    const ts = knexMigrationTimestamp(new Date('2025-06-01T08:30:45.000Z'));
    assert.strictEqual(ts, '20250601083045', 'Timestamp should be 20250601083045');
  });

  test('is always 14 chars even at midnight (no zero-padding issues)', function () {
    const ts = knexMigrationTimestamp(new Date('2026-01-01T00:00:01.000Z'));
    assert.strictEqual(ts.length, 14);
    assert.ok(ts.startsWith('2026'), 'Should start with the year');
  });
});

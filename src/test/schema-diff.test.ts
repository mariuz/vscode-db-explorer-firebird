import * as assert from 'assert';
import {
  diffSchemas,
  renderDiffReport,
  SchemaSnapshot,
  ColumnSnapshot,
} from '../schema-diff/schema-diff';

// ── Helpers ───────────────────────────────────────────────────────────────────

function col(name: string, type = 'VARCHAR', length = 50, notNull = false): ColumnSnapshot {
  return { name, type, length, notNull };
}

function emptySnapshot(): SchemaSnapshot {
  return { tables: [], views: [], procedures: [], triggers: [] };
}

// ── diffSchemas ───────────────────────────────────────────────────────────────

suite('Schema Diff – diffSchemas', function () {

  test('returns empty diff for identical empty snapshots', function () {
    const diff = diffSchemas(emptySnapshot(), emptySnapshot());
    assert.deepStrictEqual(diff.tablesOnlyInSource, []);
    assert.deepStrictEqual(diff.tablesOnlyInTarget, []);
    assert.deepStrictEqual(diff.modifiedTables, []);
    assert.deepStrictEqual(diff.viewsOnlyInSource, []);
    assert.deepStrictEqual(diff.viewsOnlyInTarget, []);
    assert.deepStrictEqual(diff.proceduresOnlyInSource, []);
    assert.deepStrictEqual(diff.proceduresOnlyInTarget, []);
    assert.deepStrictEqual(diff.triggersOnlyInSource, []);
    assert.deepStrictEqual(diff.triggersOnlyInTarget, []);
  });

  test('detects table only in source', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'CUSTOMERS', columns: [col('ID', 'INTEGER', 0)] }],
    };
    const diff = diffSchemas(source, emptySnapshot());
    assert.deepStrictEqual(diff.tablesOnlyInSource, ['CUSTOMERS']);
    assert.deepStrictEqual(diff.tablesOnlyInTarget, []);
  });

  test('detects table only in target', function () {
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'ORDERS', columns: [] }],
    };
    const diff = diffSchemas(emptySnapshot(), target);
    assert.deepStrictEqual(diff.tablesOnlyInTarget, ['ORDERS']);
    assert.deepStrictEqual(diff.tablesOnlyInSource, []);
  });

  test('detects no diff when both snapshots share identical tables', function () {
    const snapshot: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'PRODUCTS', columns: [col('ID', 'INTEGER', 0), col('NAME')] }],
    };
    const diff = diffSchemas(snapshot, snapshot);
    assert.strictEqual(diff.tablesOnlyInSource.length, 0);
    assert.strictEqual(diff.tablesOnlyInTarget.length, 0);
    assert.strictEqual(diff.modifiedTables.length, 0);
  });

  test('detects column added to target (columnsOnlyInTarget)', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0)] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0), col('NAME')] }],
    };
    const diff = diffSchemas(source, target);
    assert.strictEqual(diff.modifiedTables.length, 1);
    assert.strictEqual(diff.modifiedTables[0].name, 'T');
    assert.strictEqual(diff.modifiedTables[0].columnsOnlyInTarget.length, 1);
    assert.strictEqual(diff.modifiedTables[0].columnsOnlyInTarget[0].name, 'NAME');
    assert.strictEqual(diff.modifiedTables[0].columnsOnlyInSource.length, 0);
  });

  test('detects column removed from source (columnsOnlyInSource)', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0), col('EMAIL')] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0)] }],
    };
    const diff = diffSchemas(source, target);
    assert.strictEqual(diff.modifiedTables.length, 1);
    assert.strictEqual(diff.modifiedTables[0].columnsOnlyInSource.length, 1);
    assert.strictEqual(diff.modifiedTables[0].columnsOnlyInSource[0].name, 'EMAIL');
  });

  test('detects modified column (type change)', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('AMOUNT', 'INTEGER', 0)] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('AMOUNT', 'DECIMAL', 18)] }],
    };
    const diff = diffSchemas(source, target);
    assert.strictEqual(diff.modifiedTables.length, 1);
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns.length, 1);
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns[0].source.type, 'INTEGER');
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns[0].target.type, 'DECIMAL');
  });

  test('detects modified column (notNull change)', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [{ name: 'COL', type: 'VARCHAR', length: 50, notNull: false }] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [{ name: 'COL', type: 'VARCHAR', length: 50, notNull: true }] }],
    };
    const diff = diffSchemas(source, target);
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns.length, 1);
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns[0].source.notNull, false);
    assert.strictEqual(diff.modifiedTables[0].modifiedColumns[0].target.notNull, true);
  });

  test('detects view only in source', function () {
    const source: SchemaSnapshot = { ...emptySnapshot(), views: ['V_CUSTOMERS'] };
    const diff = diffSchemas(source, emptySnapshot());
    assert.deepStrictEqual(diff.viewsOnlyInSource, ['V_CUSTOMERS']);
  });

  test('detects view only in target', function () {
    const target: SchemaSnapshot = { ...emptySnapshot(), views: ['V_ORDERS'] };
    const diff = diffSchemas(emptySnapshot(), target);
    assert.deepStrictEqual(diff.viewsOnlyInTarget, ['V_ORDERS']);
  });

  test('detects procedure only in source', function () {
    const source: SchemaSnapshot = { ...emptySnapshot(), procedures: ['SP_GET_CUSTOMERS'] };
    const diff = diffSchemas(source, emptySnapshot());
    assert.deepStrictEqual(diff.proceduresOnlyInSource, ['SP_GET_CUSTOMERS']);
  });

  test('detects trigger only in target', function () {
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      triggers: [{ name: 'TR_BEFORE_INSERT', table: 'ORDERS', type: 1, inactive: false }],
    };
    const diff = diffSchemas(emptySnapshot(), target);
    assert.strictEqual(diff.triggersOnlyInTarget.length, 1);
    assert.strictEqual(diff.triggersOnlyInTarget[0].name, 'TR_BEFORE_INSERT');
  });

  test('triggers present in both snapshots are not reported', function () {
    const trigger = { name: 'TR_AUDIT', table: 'CUSTOMERS', type: 1, inactive: false };
    const source: SchemaSnapshot = { ...emptySnapshot(), triggers: [trigger] };
    const target: SchemaSnapshot = { ...emptySnapshot(), triggers: [trigger] };
    const diff = diffSchemas(source, target);
    assert.strictEqual(diff.triggersOnlyInSource.length, 0);
    assert.strictEqual(diff.triggersOnlyInTarget.length, 0);
  });
});

// ── renderDiffReport ──────────────────────────────────────────────────────────

suite('Schema Diff – renderDiffReport', function () {

  test('renders header with source and target labels', function () {
    const diff = diffSchemas(emptySnapshot(), emptySnapshot());
    const report = renderDiffReport(diff, 'DB_A', 'DB_B');
    assert.ok(report.includes('DB_A'), 'Report should include source label');
    assert.ok(report.includes('DB_B'), 'Report should include target label');
    assert.ok(report.includes('SCHEMA DIFF'), 'Report should include SCHEMA DIFF header');
  });

  test('renders (no differences) when schemas are identical', function () {
    const diff = diffSchemas(emptySnapshot(), emptySnapshot());
    const report = renderDiffReport(diff, 'A', 'B');
    const noDiffCount = (report.match(/\(no differences\)/g) || []).length;
    assert.ok(noDiffCount >= 4, 'All sections should report (no differences)');
  });

  test('renders table only in source with + prefix', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'CUSTOMERS', columns: [] }],
    };
    const diff = diffSchemas(source, emptySnapshot());
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('+ CUSTOMERS'), 'Missing table in source should be prefixed with +');
    assert.ok(report.includes('[only in source]'), 'Should note it is only in source');
  });

  test('renders table only in target with - prefix', function () {
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'ORDERS', columns: [] }],
    };
    const diff = diffSchemas(emptySnapshot(), target);
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('- ORDERS'), 'Missing table in target should be prefixed with -');
    assert.ok(report.includes('[only in target]'), 'Should note it is only in target');
  });

  test('renders modified table with ~ prefix', function () {
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0)] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0), col('NEW_COL')] }],
    };
    const diff = diffSchemas(source, target);
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('~ T'), 'Modified table should use ~ prefix');
    assert.ok(report.includes('[modified]'), 'Modified table should have [modified] tag');
  });

  test('renders added column in modified table with + prefix', function () {
    // A column only in SOURCE appears with + prefix (present in source, absent in target)
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0), col('SRC_ONLY_COL', 'VARCHAR', 100)] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [col('ID', 'INTEGER', 0)] }],
    };
    const diff = diffSchemas(source, target);
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('+ column: SRC_ONLY_COL'), 'Column only in source should appear with + prefix');
  });

  test('renders NOT NULL flag in column description', function () {
    // A modified column with notNull=true should show NOT NULL in the diff report
    const source: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [{ name: 'NN_COL', type: 'INTEGER', length: 0, notNull: false }] }],
    };
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      tables: [{ name: 'T', columns: [{ name: 'NN_COL', type: 'INTEGER', length: 0, notNull: true }] }],
    };
    const diff = diffSchemas(source, target);
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('NOT NULL'), 'NOT NULL should appear for modified not-null columns');
  });

  test('renders views section', function () {
    const source: SchemaSnapshot = { ...emptySnapshot(), views: ['V_CUSTOMERS'] };
    const diff = diffSchemas(source, emptySnapshot());
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('── VIEWS'), 'Report should include VIEWS section');
    assert.ok(report.includes('V_CUSTOMERS'), 'View name should appear in report');
  });

  test('renders stored procedures section', function () {
    const source: SchemaSnapshot = { ...emptySnapshot(), procedures: ['SP_CALC'] };
    const diff = diffSchemas(source, emptySnapshot());
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('── STORED PROCEDURES'), 'Report should include STORED PROCEDURES section');
    assert.ok(report.includes('SP_CALC'), 'Procedure name should appear in report');
  });

  test('renders triggers section', function () {
    const target: SchemaSnapshot = {
      ...emptySnapshot(),
      triggers: [{ name: 'TR_AUDIT', table: 'CUSTOMERS', type: 1, inactive: false }],
    };
    const diff = diffSchemas(emptySnapshot(), target);
    const report = renderDiffReport(diff, 'SRC', 'TGT');
    assert.ok(report.includes('── TRIGGERS'), 'Report should include TRIGGERS section');
    assert.ok(report.includes('TR_AUDIT'), 'Trigger name should appear in report');
    assert.ok(report.includes('ON CUSTOMERS'), 'Trigger table should appear in report');
  });

  test('report ends with separator line', function () {
    const diff = diffSchemas(emptySnapshot(), emptySnapshot());
    const report = renderDiffReport(diff, 'A', 'B');
    const trimmed = report.trimEnd();
    assert.ok(trimmed.endsWith('='.repeat(70)), 'Report should end with === separator');
  });
});

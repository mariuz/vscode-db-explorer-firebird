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

// ── renderDiffMarkdown ────────────────────────────────────────────────────────

import { renderDiffMarkdown, SchemaDiffResult } from '../schema-diff/schema-diff';

/** Fixed timestamp for deterministic snapshot tests. */
const FIXED_DATE = new Date('2025-01-15T10:30:00.000Z');

function emptyDiff(): SchemaDiffResult {
  return {
    tablesOnlyInSource: [],
    tablesOnlyInTarget: [],
    modifiedTables: [],
    viewsOnlyInSource: [],
    viewsOnlyInTarget: [],
    proceduresOnlyInSource: [],
    proceduresOnlyInTarget: [],
    triggersOnlyInSource: [],
    triggersOnlyInTarget: [],
  };
}

suite('Schema Diff – renderDiffMarkdown', function () {

  test('identical schemas produce a short "no differences" document', function () {
    const md = renderDiffMarkdown(emptyDiff(), 'DB_A', 'DB_B', FIXED_DATE);
    assert.ok(md.includes('✅'), 'Should contain the ✅ emoji for identical schemas');
    assert.ok(md.includes('no differences'), 'Should say no differences');
    assert.ok(!md.includes('## Summary'), 'Should not emit a Summary table when schemas are identical');
  });

  test('document always begins with the h1 heading', function () {
    const md = renderDiffMarkdown(emptyDiff(), 'SRC', 'TGT', FIXED_DATE);
    assert.ok(md.startsWith('# 🔍 Firebird Schema Diff'), 'Should start with the h1 heading');
  });

  test('source and target labels appear in the document', function () {
    const md = renderDiffMarkdown(emptyDiff(), 'production-db', 'staging-db', FIXED_DATE);
    assert.ok(md.includes('production-db'), 'Source label should appear');
    assert.ok(md.includes('staging-db'), 'Target label should appear');
  });

  test('generated timestamp is rendered in the document', function () {
    const md = renderDiffMarkdown(emptyDiff(), 'A', 'B', FIXED_DATE);
    // The fixed date is 2025-01-15T10:30:00.000Z; rendered as "2025-01-15 10:30:00 UTC"
    assert.ok(md.includes('2025-01-15'), 'Timestamp date should appear');
    assert.ok(md.includes('10:30:00 UTC'), 'Timestamp time+tz should appear');
  });

  test('summary table includes counts for every category', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      tablesOnlyInSource: ['T1', 'T2'],
      tablesOnlyInTarget: ['T3'],
      modifiedTables: [{ name: 'T4', columnsOnlyInSource: [], columnsOnlyInTarget: [], modifiedColumns: [] }],
      viewsOnlyInSource: ['V1'],
      proceduresOnlyInTarget: ['P1', 'P2'],
      triggersOnlyInSource: [{ name: 'TR1', table: 'T1', type: 1, inactive: false }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('## Summary'), 'Should have a Summary section');
    // Table row: 2 added, 1 removed, 1 modified
    assert.ok(md.includes('| Tables | 2 | 1 | 1 |'), 'Tables row should show correct counts');
    // Views: 1 added
    assert.ok(md.includes('| Views | 1 | 0'), 'Views row should show 1 added');
    // Procedures: 2 removed
    assert.ok(md.includes('| Procedures | 0 | 2'), 'Procedures row should show 2 removed');
    // Triggers: 1 added
    assert.ok(md.includes('| Triggers | 1 | 0'), 'Triggers row should show 1 added');
  });

  test('added table has 🆕 sigil', function () {
    const diff: SchemaDiffResult = { ...emptyDiff(), tablesOnlyInSource: ['NEW_TABLE'] };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('🆕'), 'Should contain 🆕 emoji for added table');
    assert.ok(md.includes('NEW_TABLE'), 'Table name should appear');
    assert.ok(md.includes('only in source'), 'Should note it is only in source');
  });

  test('removed table has 🗑️ sigil', function () {
    const diff: SchemaDiffResult = { ...emptyDiff(), tablesOnlyInTarget: ['OLD_TABLE'] };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('🗑️'), 'Should contain 🗑️ emoji for removed table');
    assert.ok(md.includes('OLD_TABLE'), 'Table name should appear');
    assert.ok(md.includes('only in target'), 'Should note it is only in target');
  });

  test('modified table shows ✏️ sigil and column change count', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'CUSTOMERS',
        columnsOnlyInSource: [col('EMAIL')],
        columnsOnlyInTarget: [col('PHONE')],
        modifiedColumns: [{ source: col('NAME', 'VARCHAR', 100), target: col('NAME', 'VARCHAR', 200) }],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('✏️'), 'Should contain ✏️ emoji for modified table');
    assert.ok(md.includes('CUSTOMERS'), 'Modified table name should appear');
    // 3 column changes total
    assert.ok(md.includes('3 column changes'), 'Should report 3 column changes');
  });

  test('column change table is wrapped in a GFM details block', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'T',
        columnsOnlyInSource: [col('C1')],
        columnsOnlyInTarget: [],
        modifiedColumns: [],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('<details'), 'Should use a GFM details block');
    assert.ok(md.includes('</details>'), 'Details block should be closed');
    assert.ok(md.includes('<summary>Column changes</summary>'), 'Details should have a summary');
  });

  test('column added row uses 🆕 sigil and correct data', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'T',
        columnsOnlyInSource: [col('NEW_COL', 'INTEGER', 0, true)],
        columnsOnlyInTarget: [],
        modifiedColumns: [],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('🆕 Added'), 'Column added row should have 🆕 Added');
    assert.ok(md.includes('NEW_COL'), 'Column name should appear');
    assert.ok(md.includes('YES'), 'NOT NULL should be shown as YES');
  });

  test('column removed row uses 🗑️ sigil', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'T',
        columnsOnlyInSource: [],
        columnsOnlyInTarget: [col('GONE_COL')],
        modifiedColumns: [],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('🗑️ Removed'), 'Column removed row should have 🗑️ Removed');
    assert.ok(md.includes('GONE_COL'), 'Column name should appear');
  });

  test('modified column shows source → target for type, length and nullability', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'T',
        columnsOnlyInSource: [],
        columnsOnlyInTarget: [],
        modifiedColumns: [{
          source: col('AMOUNT', 'NUMERIC', 10, false),
          target: col('AMOUNT', 'DECIMAL', 15, true),
        }],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('✏️ Modified'), 'Modified column row should have ✏️ Modified');
    assert.ok(md.includes('AMOUNT'), 'Column name should appear');
    assert.ok(md.includes('NUMERIC → DECIMAL'), 'Type change should be shown as arrow');
    assert.ok(md.includes('10 → 15'), 'Length change should be shown');
    assert.ok(md.includes('no → YES'), 'Nullability change should be shown');
  });

  test('views section is omitted when there are no view differences', function () {
    const md = renderDiffMarkdown(emptyDiff(), 'A', 'B', FIXED_DATE);
    assert.ok(!md.includes('## Views'), 'Views section should be absent when no view changes');
  });

  test('views section lists added and removed views with correct sigils', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      viewsOnlyInSource: ['V_NEW'],
      viewsOnlyInTarget: ['V_OLD'],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('## Views'), 'Views section should be present');
    assert.ok(md.includes('V_NEW'), 'Added view should be listed');
    assert.ok(md.includes('V_OLD'), 'Removed view should be listed');
  });

  test('triggers section lists name and table', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      triggersOnlyInSource: [{ name: 'TR_INSERT', table: 'ORDERS', type: 1, inactive: false }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('## Triggers'), 'Triggers section should be present');
    assert.ok(md.includes('TR_INSERT'), 'Trigger name should appear');
    assert.ok(md.includes('ORDERS'), 'Trigger table should appear');
  });

  test('footer contains a Firebird Studio attribution link', function () {
    const diff: SchemaDiffResult = { ...emptyDiff(), viewsOnlyInSource: ['V'] };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('Firebird Studio'), 'Footer should attribute to Firebird Studio');
    assert.ok(md.includes('marketplace.visualstudio.com'), 'Footer should link to the marketplace');
  });

  test('singular "column change" (not plural) when exactly one change exists', function () {
    const diff: SchemaDiffResult = {
      ...emptyDiff(),
      modifiedTables: [{
        name: 'T',
        columnsOnlyInSource: [col('C')],
        columnsOnlyInTarget: [],
        modifiedColumns: [],
      }],
    };
    const md = renderDiffMarkdown(diff, 'A', 'B', FIXED_DATE);
    assert.ok(md.includes('1 column change'), 'Should use singular form');
    assert.ok(!md.includes('1 column changes'), 'Should NOT use plural form for singular');
  });
});


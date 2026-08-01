/**
 * Unit tests for plan-parser.ts. Every fixture string below was captured verbatim from a real
 * Firebird 3.0 server (`SET PLANONLY ON` against a scratch database with EMP/DEPT tables and a
 * few indexes), not invented from documentation — see plan-parser.ts's file header for how and
 * why, and the two assumptions that captured evidence corrected.
 */

import { renderIndexMetadataPlan } from '../shared/sql-analysis';
import * as assert from 'assert';
import { parsePlan, PlanNode, interpretPlanText } from '../shared/plan-parser';

suite('parsePlan()', function () {

  test('a natural scan', function () {
    const [node] = parsePlan('PLAN (EMP NATURAL)');
    assert.deepStrictEqual(node, { kind: 'scan', table: 'EMP', method: 'NATURAL' });
  });

  test('a single-index scan', function () {
    const [node] = parsePlan('PLAN (EMP INDEX (PK_EMP))');
    assert.deepStrictEqual(node, { kind: 'scan', table: 'EMP', method: 'INDEX', indexes: ['PK_EMP'] });
  });

  test('a multi-index scan (OR-combined indexes on one table)', function () {
    const [node] = parsePlan('PLAN (EMP INDEX (PK_EMP, IDX_EMP_SALARY))');
    assert.deepStrictEqual(node, { kind: 'scan', table: 'EMP', method: 'INDEX', indexes: ['PK_EMP', 'IDX_EMP_SALARY'] });
  });

  test('an index-ordered scan (ORDER BY satisfied by an index, no physical sort)', function () {
    const [node] = parsePlan('PLAN (EMP ORDER IDX_EMP_SALARY)');
    assert.deepStrictEqual(node, { kind: 'scan', table: 'EMP', method: 'ORDER', index: 'IDX_EMP_SALARY' });
  });

  test('a 2-way nested-loop join is a FLAT list of scans, not nested sub-plans', function () {
    const [node] = parsePlan('PLAN JOIN (D NATURAL, E INDEX (FK_EMP_DEPT))');
    assert.deepStrictEqual(node, {
      kind: 'JOIN',
      children: [
        { kind: 'scan', table: 'D', method: 'NATURAL' },
        { kind: 'scan', table: 'E', method: 'INDEX', indexes: ['FK_EMP_DEPT'] },
      ],
    });
  });

  test('a 3-way join is still a flat list, not pairwise-nested', function () {
    const [node] = parsePlan('PLAN JOIN (D NATURAL, E INDEX (FK_EMP_DEPT), E2 INDEX (PK_EMP))');
    assert.strictEqual((node as { children: PlanNode[] }).children.length, 3);
  });

  test('a hash join', function () {
    const [node] = parsePlan('PLAN HASH (E NATURAL, D NATURAL)');
    assert.strictEqual(node.kind, 'HASH');
    assert.strictEqual((node as { children: PlanNode[] }).children.length, 2);
  });

  test('a sort wrapping a single scan', function () {
    const [node] = parsePlan('PLAN SORT (EMP NATURAL)');
    assert.deepStrictEqual(node, { kind: 'SORT', children: [{ kind: 'scan', table: 'EMP', method: 'NATURAL' }] });
  });

  test('a sort wrapping a flat list of scans directly (captured from a UNION query, not a join)', function () {
    const [node] = parsePlan('PLAN SORT (EMP NATURAL, EMP INDEX (IDX_EMP_SALARY))');
    assert.strictEqual(node.kind, 'SORT');
    assert.strictEqual((node as { children: PlanNode[] }).children.length, 2);
  });

  test('a sort wrapping a nested join (captured from a joined query with an unsatisfied ORDER BY)', function () {
    const [node] = parsePlan('PLAN SORT (JOIN (D NATURAL, E INDEX (FK_EMP_DEPT)))');
    assert.strictEqual(node.kind, 'SORT');
    const children = (node as { children: PlanNode[] }).children;
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].kind, 'JOIN');
  });

  test('mixed-case (quoted) object names round-trip verbatim, with no quotes in the plan text', function () {
    const [node] = parsePlan('PLAN (MixedCase INDEX (PK_Mixed))');
    assert.deepStrictEqual(node, { kind: 'scan', table: 'MixedCase', method: 'INDEX', indexes: ['PK_Mixed'] });
  });

  test('a plan text with multiple top-level PLAN blocks (captured from a statement with an EXISTS subquery)', function () {
    const blocks = parsePlan('PLAN (D INDEX (PK_DEPT))\nPLAN (E NATURAL)');
    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(blocks[0], { kind: 'scan', table: 'D', method: 'INDEX', indexes: ['PK_DEPT'] });
    assert.deepStrictEqual(blocks[1], { kind: 'scan', table: 'E', method: 'NATURAL' });
  });

  test('returns an empty array for empty input', function () {
    assert.deepStrictEqual(parsePlan(''), []);
    assert.deepStrictEqual(parsePlan('   \n  '), []);
  });

  test('throws a descriptive error on malformed input rather than silently misparsing', function () {
    assert.throws(() => parsePlan('PLAN (EMP)'), /Expected NATURAL, INDEX, or ORDER/);
    assert.throws(() => parsePlan('JOIN (EMP NATURAL)'), /Expected "PLAN"/);
    assert.throws(() => parsePlan('PLAN JOIN (EMP NATURAL'), /Unexpected end of plan text/);
  });

  test('throws (rather than silently misparsing) on the pure-JS driver\'s heuristic fallback text', function () {
    const fallback = '-- PLAN not available via node-firebird driver.\n-- Use the native driver (firebird.useNativeDriver) for execution plans.\n-- Query:\nSELECT 1 FROM RDB$DATABASE';
    assert.throws(() => parsePlan(fallback));
  });
});

// ── interpretPlanText() ──────────────────────────────────────────────────────
//
// Shared by QueryPlanView and ResultView's "Query Plan" tab (docs/roadmap/query-plan-visualizer.md
// phase 4) so both surface identical fallback/parse-error messages for identical inputs.

suite('interpretPlanText()', function () {

  test('a real, parseable plan yields blocks and the original raw text', function () {
    const result = interpretPlanText('PLAN (EMP NATURAL)');
    assert.ok('blocks' in result, JSON.stringify(result));
    if ('blocks' in result) {
      assert.deepStrictEqual(result.blocks, [{ kind: 'scan', table: 'EMP', method: 'NATURAL' }]);
      assert.strictEqual(result.raw, 'PLAN (EMP NATURAL)');
    }
  });

  test('the pure-JS driver\'s heuristic fallback text is detected before parsing is even attempted, with an actionable message', function () {
    const fallback = '-- PLAN not available via node-firebird driver.\n-- Use the native driver (firebird.useNativeDriver) for execution plans.';
    const result = interpretPlanText(fallback);
    assert.ok('error' in result, JSON.stringify(result));
    if ('error' in result) {
      assert.match(result.error, /native driver/);
      assert.strictEqual(result.raw, fallback);
    }
  });

  test('the index-metadata fallback prefix is detected too', function () {
    const fallback = '-- Firebird Index Metadata (pure-JS driver heuristic)\nSELECT 1 FROM RDB$DATABASE';
    const result = interpretPlanText(fallback);
    assert.ok('error' in result, JSON.stringify(result));
  });

  test('malformed plan text (not a fallback, not valid syntax) yields a parse-error message, not a thrown exception', function () {
    const result = interpretPlanText('PLAN (EMP)');
    assert.ok('error' in result, JSON.stringify(result));
    if ('error' in result) {
      assert.match(result.error, /Couldn't parse the plan/);
      assert.match(result.error, /Expected NATURAL, INDEX, or ORDER/);
      assert.strictEqual(result.raw, 'PLAN (EMP)');
    }
  });
});

suite('interpretPlanText() — every pure-JS fallback shape is recognised', function () {
  // Driven straight out of renderIndexMetadataPlan() rather than from hand-copied strings: the
  // original prefix list was written against two of its three return paths, and the third — a
  // table with no indexes — reached the parser and produced a confusing syntax error instead of
  // the intended "enable the native driver" message.
  const cases: [string, string][] = [
    ['no tables in the statement', renderIndexMetadataPlan('SELECT 1 FROM RDB$DATABASE', [], [])],
    ['a table with no indexes', renderIndexMetadataPlan('SELECT * FROM CAP_DEMO', ['CAP_DEMO'], [])],
    ['a table with indexes', renderIndexMetadataPlan('SELECT * FROM T', ['T'], [
      { TABLE_NAME: 'T', INDEX_NAME: 'PK_T', FIELD_NAME: 'ID', UNIQUE_FLAG: 1 },
    ])],
  ];

  for (const [label, text] of cases) {
    test(`${label} is reported as needing the native driver, not as a parse error`, function () {
      const result = interpretPlanText(text) as any;
      assert.ok(result.error, `expected an explanatory error for: ${text.slice(0, 60)}`);
      assert.ok(
        /native driver/i.test(result.error),
        `expected the native-driver message, got: ${result.error}`
      );
      assert.ok(!/couldn't parse|expected "PLAN"/i.test(result.error), result.error);
    });
  }
});

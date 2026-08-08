/**
 * Knex migration code-generator for Firebird Schema Diff.
 *
 * Converts a `PublishDiff` (the same object `buildPublishScript()` uses to produce raw DDL) into
 * a ready-to-run Knex migration file compatible with `knex-firebird-dialect` ≥ 2.x.
 *
 * Design decisions worth recording:
 *
 *  - **Zero runtime dependency on Knex itself.**  This is a pure string-builder.  The generated
 *    file is opened in the editor for review — the user runs it, not this extension.  That keeps
 *    the extension's install footprint unchanged and lets the generated file's Knex version be
 *    whatever the target project uses, not whatever we pinned here.
 *
 *  - **`exports.up` / `exports.down` style (CommonJS), not `export async function`.**  Knex
 *    itself defaults to CJS and `knex-firebird-dialect` follows suit; the generated file can be
 *    placed directly into a `migrations/` folder without any compilation step.  A `language`
 *    parameter offers TypeScript output for projects that prefer it.
 *
 *  - **`exports.up` does what `buildPublishScript()` does in SQL — the `exports.down` is best-
 *    effort only** and is flagged as such.  A true rollback would require the pre-migration state,
 *    which we do not have at generation time.  For destructive `up` changes (DROP TABLE, DROP
 *    COLUMN) the down is left as a comment so the developer can fill it in.
 *
 *  - **Knex does not cover all of Firebird's DDL.**  Generators (sequences), stored procedures,
 *    triggers and views cannot be expressed as Knex schema-builder calls.  They are emitted as
 *    `knex.raw(...)` calls, which is the same escape hatch `knex-firebird-dialect` recommends.
 *
 *  - **`includeDrops` is explicit opt-in**, identical to `buildPublishScript()`'s own option, so
 *    the default output is safe (additive-only).
 */

import { PublishDiff, TableDiff, ColumnChange } from '../database-projects/publish-model';
import { SchemaTable, SchemaColumn, SchemaRelationship } from '../schema-designer/schema-graph';
import { DomainSource, ViewSource, ProcedureSource, TriggerSource, columnTypeToDDL } from '../database-projects/project-model';

export interface KnexMigrationOptions {
  /**
   * Whether to emit DROP statements for objects present only in the target (the "old" database).
   * Defaults to `false` — additive-only, the safe default.
   */
  includeDrops?: boolean;
  /**
   * Output language.  `"ts"` wraps the file in TypeScript types.  `"js"` (default) is plain CJS.
   */
  language?: 'js' | 'ts';
  /**
   * Optional ISO timestamp injected into the file header.  Defaults to `new Date().toISOString()`.
   */
  generatedAt?: string;
}

// ── Firebird type → Knex column-builder method ────────────────────────────────

/**
 * Maps a Firebird column to the best-fit Knex `table.<method>(name)` call.
 * Where Knex has no direct equivalent the column is emitted via `table.specificType()`.
 */
function columnToKnex(col: SchemaColumn, tableName: string, indent: string): string {
  const q = (s: string) => `'${s}'`;
  const name = q(col.name);

  let builder: string;

  if ((col.subType === 1 || col.subType === 2) && col.precision) {
    // NUMERIC / DECIMAL — Knex uses .decimal(name, precision, scale)
    const scale = col.scale ? -col.scale : 0;
    builder = `table.decimal(${name}, ${col.precision}, ${scale})`;
  } else {
    switch (col.type) {
      case 'VARCHAR':
        builder = `table.string(${name}, ${col.length || 255})`;
        break;
      case 'CHAR':
        builder = `table.specificType(${name}, 'CHAR(${col.length || 1})')`;
        break;
      case 'SMALLINT':
        builder = `table.specificType(${name}, 'SMALLINT')`;
        break;
      case 'INTEGER':
        builder = `table.integer(${name})`;
        break;
      case 'INT64':
        builder = `table.bigInteger(${name})`;
        break;
      case 'FLOAT':
        builder = `table.float(${name})`;
        break;
      case 'DOUBLE':
      case 'D_FLOAT':
        builder = `table.double(${name})`;
        break;
      case 'DATE':
        builder = `table.date(${name})`;
        break;
      case 'TIME':
        builder = `table.specificType(${name}, 'TIME')`;
        break;
      case 'TIMESTAMP':
        builder = `table.timestamp(${name}, { useTz: false })`;
        break;
      case 'BLOB':
        builder = `table.binary(${name})`;
        break;
      case 'BOOLEAN':
        builder = `table.boolean(${name})`;
        break;
      default:
        // Unknown or domain-based type — use specificType with the raw DDL string
        builder = `table.specificType(${name}, '${columnTypeToDDL(col)}')`;
        break;
    }
  }

  // Chain .notNullable() / .nullable()
  builder += col.notNull ? '.notNullable()' : '.nullable()';

  // Default value
  if (col.dflt !== undefined && col.dflt !== '') {
    builder += `.defaultTo(knex.raw('${col.dflt.replace(/'/g, "\\'")}'))`;
  }

  // Primary key (single-column shorthand — composite PKs are handled separately)
  if (col.isPrimaryKey) {
    builder += '.primary()';
  }

  return `${indent}${builder};`;
}

// ── Table builders ─────────────────────────────────────────────────────────────

function tableCreate(table: SchemaTable, indent: string): string[] {
  const lines: string[] = [];
  const i2 = indent + '  ';

  lines.push(`${indent}await knex.schema.createTable('${table.name}', (table) => {`);

  const pkCols = table.columns.filter(c => c.isPrimaryKey);

  for (const col of table.columns) {
    // If this column is part of a composite PK, don't emit .primary() per-column —
    // we'll emit table.primary([...]) instead.
    const colForEmit: SchemaColumn = pkCols.length > 1 ? { ...col, isPrimaryKey: false } : col;
    lines.push(columnToKnex(colForEmit, table.name, i2));
  }

  if (pkCols.length > 1) {
    const pkNames = pkCols.map(c => `'${c.name}'`).join(', ');
    lines.push(`${i2}table.primary([${pkNames}]);`);
  }

  lines.push(`${indent}});`);
  return lines;
}

function tableDrop(tableName: string, indent: string): string[] {
  return [`${indent}await knex.schema.dropTableIfExists('${tableName}');`];
}

function tableAlter(diff: TableDiff, indent: string): string[] {
  const lines: string[] = [];
  const i2 = indent + '  ';

  const hasChanges =
    diff.addedColumns.length > 0 ||
    diff.droppedColumns.length > 0 ||
    diff.changedColumns.length > 0;

  if (!hasChanges) { return lines; }

  lines.push(`${indent}await knex.schema.alterTable('${diff.name}', (table) => {`);

  // Added columns
  for (const col of diff.addedColumns) {
    lines.push(columnToKnex(col, diff.name, i2));
  }

  // Dropped columns (Firebird supports ALTER TABLE ... DROP COLUMN)
  for (const colName of diff.droppedColumns) {
    lines.push(`${i2}table.dropColumn('${colName}');`);
  }

  // Modified columns — Knex's .alter() chains after the column builder
  for (const change of diff.changedColumns) {
    const col = change.source; // "source" is the desired new shape
    const colForAlter: SchemaColumn = { ...col, isPrimaryKey: false };
    const built = columnToKnex(colForAlter, diff.name, i2);
    // Append .alter() before the trailing semicolon
    lines.push(built.replace(/;$/, '.alter();'));
  }

  lines.push(`${indent}});`);
  return lines;
}

// ── Foreign key builders ───────────────────────────────────────────────────────

function fkAdd(rel: SchemaRelationship, indent: string): string[] {
  return [
    `${indent}await knex.schema.alterTable('${rel.table}', (table) => {`,
    `${indent}  table.foreign('${rel.column}', '${rel.constraintName}')`,
    `${indent}    .references('${rel.refColumn}')`,
    `${indent}    .inTable('${rel.refTable}');`,
    `${indent}});`,
  ];
}

function fkDrop(rel: SchemaRelationship, indent: string): string[] {
  return [
    `${indent}await knex.schema.alterTable('${rel.table}', (table) => {`,
    `${indent}  table.dropForeign('${rel.column}', '${rel.constraintName}');`,
    `${indent}});`,
  ];
}

// ── Raw-SQL helpers (for DDL Knex cannot express natively) ────────────────────

function raw(sql: string, indent: string): string[] {
  // Escape backticks inside the SQL to avoid breaking the template literal.
  const escaped = sql.replace(/`/g, '\\`');
  return [`${indent}await knex.raw(\`${escaped}\`);`];
}

// ── Section comment ───────────────────────────────────────────────────────────

function section(label: string, indent: string): string[] {
  return [``, `${indent}// ── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`];
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Renders a `PublishDiff` as a ready-to-use Knex migration file (CommonJS or TypeScript).
 *
 * The generated file imports nothing from this extension — it is a standalone text artifact the
 * developer places in their project's `migrations/` directory alongside whatever other Knex
 * migration files they already have.
 */
export function renderKnexMigration(
  diff: PublishDiff,
  sourceLabel: string,
  targetLabel: string,
  options: KnexMigrationOptions = {}
): string {
  const {
    includeDrops = false,
    language = 'js',
    generatedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
  } = options;

  const isTs = language === 'ts';
  const indent = '  ';

  const totalChanges =
    diff.newTables.length + (includeDrops ? diff.droppedTables.length : 0) +
    diff.modifiedTables.length +
    diff.newForeignKeys.length + (includeDrops ? diff.droppedForeignKeys.length : 0) +
    diff.newGenerators.length + (includeDrops ? diff.droppedGenerators.length : 0) +
    diff.newDomains.length + diff.changedDomains.length + (includeDrops ? diff.droppedDomains.length : 0) +
    diff.newViews.length + diff.changedViews.length + (includeDrops ? diff.droppedViews.length : 0) +
    diff.newProcedures.length + diff.changedProcedures.length + (includeDrops ? diff.droppedProcedures.length : 0) +
    diff.newTriggers.length + diff.changedTriggers.length + (includeDrops ? diff.droppedTriggers.length : 0) +
    diff.newExceptions.length + diff.changedExceptions.length + (includeDrops ? diff.droppedExceptions.length : 0) +
    diff.newRoles.length + (includeDrops ? diff.droppedRoles.length : 0) +
    diff.newUsers.length + (includeDrops ? diff.droppedUsers.length : 0);

  const lines: string[] = [];

  // ── File header ──
  lines.push(`/**`);
  lines.push(` * Firebird Knex migration`);
  lines.push(` * Source:    ${sourceLabel}`);
  lines.push(` * Target:    ${targetLabel}`);
  lines.push(` * Generated: ${generatedAt}`);
  lines.push(` *`);
  lines.push(` * Usage:`);
  lines.push(` *   npm install knex knex-firebird-dialect`);
  lines.push(` *   knex migrate:latest --knexfile knexfile.js`);
  lines.push(` *`);
  lines.push(` * IMPORTANT: Review this file carefully before running it.`);
  lines.push(` * Generated code is additive-only by default.`);
  if (!includeDrops && (diff.droppedTables.length + diff.droppedDomains.length +
      diff.modifiedTables.reduce((n, t) => n + t.droppedColumns.length, 0)) > 0) {
    lines.push(` * Re-generate with includeDrops=true to also drop removed objects.`);
  }
  lines.push(` */`);
  lines.push(``);

  if (isTs) {
    lines.push(`import type { Knex } from 'knex';`);
    lines.push(``);
    lines.push(`export async function up(knex: Knex): Promise<void> {`);
  } else {
    lines.push(`/**`);
    lines.push(` * @param {import('knex').Knex} knex`);
    lines.push(` * @returns {Promise<void>}`);
    lines.push(` */`);
    lines.push(`exports.up = async function (knex) {`);
  }

  if (totalChanges === 0) {
    lines.push(`${indent}// No schema changes detected between the two databases.`);
  } else {
    // ── 1. Drop FKs that are being removed or whose columns are changing ──
    const fksToDrop = includeDrops ? diff.droppedForeignKeys : [];
    // Also drop FKs on modified tables before altering their columns
    const fksOnModifiedTables = diff.droppedForeignKeys.filter(fk =>
      diff.modifiedTables.some(t => t.name === fk.table)
    );
    const allFkDrops = [...new Set([...fksToDrop, ...fksOnModifiedTables])];
    if (allFkDrops.length > 0) {
      lines.push(...section('Drop foreign keys (before altering columns)', indent));
      for (const rel of allFkDrops) {
        lines.push(...fkDrop(rel, indent).map(l => indent + l.trimStart()));
      }
    }

    // ── 2. Create sequences (generators) ──
    if (diff.newGenerators.length > 0) {
      lines.push(...section('Create sequences (generators)', indent));
      for (const gen of diff.newGenerators) {
        lines.push(...raw(`CREATE SEQUENCE ${gen};`, indent));
      }
    }

    // ── 3. Create / alter domains ──
    if (diff.newDomains.length > 0) {
      lines.push(...section('Create domains', indent));
      for (const d of diff.newDomains) {
        const notNull = d.notNull ? ' NOT NULL' : '';
        const dflt = d.dflt ? ` DEFAULT ${d.dflt}` : '';
        const check = d.check ? ` ${d.check}` : '';
        const typeExpr = columnTypeToDDL(d as any);
        lines.push(...raw(`CREATE DOMAIN ${d.name} AS ${typeExpr}${dflt}${notNull}${check};`, indent));
      }
    }
    if (diff.changedDomains.length > 0) {
      lines.push(...section('Alter domains', indent));
      for (const dc of diff.changedDomains) {
        const d = dc.source;
        const typeExpr = columnTypeToDDL(d as any);
        lines.push(...raw(`ALTER DOMAIN ${d.name} TYPE ${typeExpr};`, indent));
      }
    }

    // ── 4. Create new tables ──
    if (diff.newTables.length > 0) {
      lines.push(...section('Create tables', indent));
      for (const table of diff.newTables) {
        lines.push(...tableCreate(table, indent));
      }
    }

    // ── 5. Alter existing tables ──
    if (diff.modifiedTables.length > 0) {
      lines.push(...section('Alter tables', indent));
      for (const td of diff.modifiedTables) {
        lines.push(...tableAlter(td, indent));
      }
    }

    // ── 6. Add / re-add foreign keys ──
    const fksToAdd = [...diff.newForeignKeys];
    if (fksOnModifiedTables.length > 0) {
      // Re-add the FKs we dropped in step 1 for modified tables
      fksToAdd.push(...fksOnModifiedTables);
    }
    if (fksToAdd.length > 0) {
      lines.push(...section('Add foreign keys', indent));
      for (const rel of fksToAdd) {
        lines.push(...fkAdd(rel, indent));
      }
    }

    // ── 7. Exceptions ──
    if (diff.newExceptions.length > 0 || diff.changedExceptions.length > 0) {
      lines.push(...section('Create / alter exceptions', indent));
      for (const ex of [...diff.newExceptions, ...diff.changedExceptions]) {
        lines.push(...raw(`CREATE OR ALTER EXCEPTION ${ex.name} '${ex.message.replace(/'/g, "''")}';`, indent));
      }
    }

    // ── 8. Views ──
    if (diff.newViews.length > 0 || diff.changedViews.length > 0) {
      lines.push(...section('Create / alter views', indent));
      for (const v of [...diff.newViews, ...diff.changedViews]) {
        lines.push(...raw(`CREATE OR ALTER VIEW ${v.name}\\nAS\\n${v.source};`, indent));
      }
    }

    // ── 9. Stored procedures ──
    if (diff.newProcedures.length > 0 || diff.changedProcedures.length > 0) {
      lines.push(...section('Create / alter stored procedures', indent));
      for (const p of [...diff.newProcedures, ...diff.changedProcedures]) {
        lines.push(...raw(`CREATE OR ALTER PROCEDURE ${p.name}\\n${p.source};`, indent));
      }
    }

    // ── 10. Triggers ──
    if (diff.newTriggers.length > 0 || diff.changedTriggers.length > 0) {
      lines.push(...section('Create / alter triggers', indent));
      for (const t of [...diff.newTriggers, ...diff.changedTriggers]) {
        lines.push(...raw(`CREATE OR ALTER TRIGGER ${t.name}\\n${t.source};`, indent));
      }
    }

    // ── 11. Drops (opt-in) ──
    if (includeDrops) {
      if (diff.droppedTriggers.length > 0) {
        lines.push(...section('Drop triggers', indent));
        for (const t of diff.droppedTriggers) {
          lines.push(...raw(`DROP TRIGGER ${t.name};`, indent));
        }
      }
      if (diff.droppedViews.length > 0) {
        lines.push(...section('Drop views', indent));
        for (const v of diff.droppedViews) {
          lines.push(...raw(`DROP VIEW ${v.name};`, indent));
        }
      }
      if (diff.droppedProcedures.length > 0) {
        lines.push(...section('Drop stored procedures', indent));
        for (const p of diff.droppedProcedures) {
          lines.push(...raw(`DROP PROCEDURE ${p.name};`, indent));
        }
      }
      if (diff.droppedTables.length > 0) {
        lines.push(...section('Drop tables', indent));
        for (const name of diff.droppedTables) {
          lines.push(...tableDrop(name, indent));
        }
      }
      if (diff.droppedDomains.length > 0) {
        lines.push(...section('Drop domains', indent));
        for (const name of diff.droppedDomains) {
          lines.push(...raw(`DROP DOMAIN ${name};`, indent));
        }
      }
      if (diff.droppedGenerators.length > 0) {
        lines.push(...section('Drop sequences', indent));
        for (const name of diff.droppedGenerators) {
          lines.push(...raw(`DROP SEQUENCE ${name};`, indent));
        }
      }
    }
  }

  if (isTs) {
    lines.push(`}`);
    lines.push(``);
    lines.push(`/**`);
    lines.push(` * Best-effort rollback — review and complete before using.`);
    lines.push(` * Destructive operations in \`up\` (DROP TABLE, DROP COLUMN) cannot be auto-reversed.`);
    lines.push(` */`);
    lines.push(`export async function down(knex: Knex): Promise<void> {`);
    lines.push(`${indent}// TODO: implement rollback if needed`);
    lines.push(`}`);
  } else {
    lines.push(`};`);
    lines.push(``);
    lines.push(`/**`);
    lines.push(` * Best-effort rollback — review and complete before using.`);
    lines.push(` * Destructive operations in \`up\` (DROP TABLE, DROP COLUMN) cannot be auto-reversed.`);
    lines.push(` * @param {import('knex').Knex} knex`);
    lines.push(` * @returns {Promise<void>}`);
    lines.push(` */`);
    lines.push(`exports.down = async function (knex) {`);
    lines.push(`${indent}// TODO: implement rollback if needed`);
    lines.push(`};`);
  }

  lines.push(``);
  return lines.join('\n');
}

/** Returns a Knex-convention timestamp prefix for the migration filename, e.g. "20260808123456". */
export function knexMigrationTimestamp(at: Date = new Date()): string {
  return at.toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
}

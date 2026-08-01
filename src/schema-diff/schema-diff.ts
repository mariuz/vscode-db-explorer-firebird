import { ConnectionOptions } from '../interfaces';
import { Driver } from '../shared/driver';
import {
  getTablesQuery,
  fieldsQuery,
  getViewsQuery,
  getStoredProceduresQuery,
  getTriggersQuery,
} from '../shared/queries';
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas, schemaDisplayName } from "../shared/schema-support";

export interface SchemaSnapshot {
  tables: TableSnapshot[];
  views: string[];
  procedures: string[];
  triggers: TriggerSnapshot[];
}

export interface TableSnapshot {
  name: string;
  columns: ColumnSnapshot[];
}

export interface ColumnSnapshot {
  name: string;
  type: string;
  length: number;
  notNull: boolean;
}

export interface TriggerSnapshot {
  name: string;
  table: string;
  type: number;
  inactive: boolean;
}

export interface SchemaDiffResult {
  tablesOnlyInSource: string[];
  tablesOnlyInTarget: string[];
  modifiedTables: ModifiedTable[];
  viewsOnlyInSource: string[];
  viewsOnlyInTarget: string[];
  proceduresOnlyInSource: string[];
  proceduresOnlyInTarget: string[];
  triggersOnlyInSource: TriggerSnapshot[];
  triggersOnlyInTarget: TriggerSnapshot[];
}

export interface ModifiedTable {
  name: string;
  columnsOnlyInSource: ColumnSnapshot[];
  columnsOnlyInTarget: ColumnSnapshot[];
  modifiedColumns: { source: ColumnSnapshot; target: ColumnSnapshot }[];
}

/** Fetches the schema snapshot for a given connection */
export async function fetchSchemaSnapshot(conn: ConnectionOptions, maxTables: number): Promise<SchemaSnapshot> {
  const connection = await Driver.client.createConnection(conn);
  try {
    // Firebird 6 keeps every object in a schema. Without asking for it, two same-named tables in
    // different schemas collapse into one snapshot entry whose columns are the union of both — so
    // a diff would report phantom added/removed columns for a table that does not exist. Gated on
    // the server version, since RDB$SCHEMA_NAME is a hard error before Firebird 6.
    const withSchemas = supportsSchemas(
      await getEngineMajorVersion(conn.id, (sql: string) => Driver.client.queryPromise<any>(connection, sql))
    );
    /**
     * Snapshot key and display name.
     *
     * Uses the *display* form — bare in the default schema, qualified elsewhere — rather than
     * always qualifying. Two reasons. A single-schema Firebird 6 database then produces exactly
     * the snapshot it produced before schemas existed, so a comparison against a Firebird 5
     * database (or a project extracted from one) still lines up. And Database Projects names its
     * files the same way, so publish compares like with like; qualifying unconditionally made
     * every object in a single-schema database look renamed, which the suite-tier publish tests
     * caught as `PUB_PARENT should exist in the target snapshot`.
     */
    const qualify = (schema: unknown, name: unknown) =>
      schemaDisplayName(withSchemas ? String(schema ?? "") : undefined, String(name ?? ""));

    // Tables
    const tableRows: any[] = await Driver.client.queryPromise(connection, getTablesQuery(maxTables, withSchemas));
    const tableNames = (tableRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.TABLE_NAME));

    let columns: any[] = [];
    if (tableNames.length > 0) {
      // The IN list matches on bare relation names; rows are then keyed by schema + name below,
      // which is what keeps two same-named tables apart.
      const bareNames = (tableRows ?? []).map(r => String(r.TABLE_NAME).trim());
      columns = await Driver.client.queryPromise(connection, fieldsQuery(bareNames, withSchemas));
    }

    const tableMap: Record<string, ColumnSnapshot[]> = {};
    for (const name of tableNames) {
      tableMap[name] = [];
    }
    for (const col of (columns ?? [])) {
      const tbl = qualify(col.SCHEMA_NAME, col.TBL);
      if (tableMap[tbl]) {
        tableMap[tbl].push({
          name: col.FIELD.trim(),
          type: col.FIELD_TYPE.trim(),
          length: col.FIELD_LENGTH ?? 0,
          notNull: col.NOTNULL === '1',
        });
      }
    }

    const tables: TableSnapshot[] = tableNames.map(name => ({
      name,
      columns: tableMap[name] ?? [],
    }));

    // Views
    const viewRows: any[] = await Driver.client.queryPromise(connection, getViewsQuery(withSchemas));
    const views = (viewRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.VIEW_NAME));

    // Procedures
    const procRows: any[] = await Driver.client.queryPromise(connection, getStoredProceduresQuery(withSchemas));
    const procedures = (procRows ?? []).map(r => qualify(r.SCHEMA_NAME, r.PROCEDURE_NAME));

    // Triggers
    const trigRows: any[] = await Driver.client.queryPromise(connection, getTriggersQuery(withSchemas));
    const triggers: TriggerSnapshot[] = (trigRows ?? []).map(r => ({
      name: qualify(r.SCHEMA_NAME, r.TRIGGER_NAME),
      table: r.TABLE_NAME ? qualify(r.SCHEMA_NAME, r.TABLE_NAME) : '',
      type: r.TRIGGER_TYPE ?? 0,
      inactive: !!r.INACTIVE,
    }));

    return { tables, views, procedures, triggers };
  } finally {
    await Driver.client.detach(connection);
  }
}

/** Compares two schema snapshots and returns the differences */
export function diffSchemas(source: SchemaSnapshot, target: SchemaSnapshot): SchemaDiffResult {
  const sourceTableMap = new Map(source.tables.map(t => [t.name, t]));
  const targetTableMap = new Map(target.tables.map(t => [t.name, t]));

  const tablesOnlyInSource = source.tables.map(t => t.name).filter(n => !targetTableMap.has(n));
  const tablesOnlyInTarget = target.tables.map(t => t.name).filter(n => !sourceTableMap.has(n));

  const modifiedTables: ModifiedTable[] = [];
  for (const sourceTbl of source.tables) {
    const targetTbl = targetTableMap.get(sourceTbl.name);
    if (!targetTbl) {
      continue;
    }
    const sourceColMap = new Map(sourceTbl.columns.map(c => [c.name, c]));
    const targetColMap = new Map(targetTbl.columns.map(c => [c.name, c]));

    const columnsOnlyInSource = sourceTbl.columns.filter(c => !targetColMap.has(c.name));
    const columnsOnlyInTarget = targetTbl.columns.filter(c => !sourceColMap.has(c.name));
    const modifiedColumns: { source: ColumnSnapshot; target: ColumnSnapshot }[] = [];

    for (const sourceCol of sourceTbl.columns) {
      const targetCol = targetColMap.get(sourceCol.name);
      if (targetCol && !columnsEqual(sourceCol, targetCol)) {
        modifiedColumns.push({ source: sourceCol, target: targetCol });
      }
    }

    if (columnsOnlyInSource.length > 0 || columnsOnlyInTarget.length > 0 || modifiedColumns.length > 0) {
      modifiedTables.push({ name: sourceTbl.name, columnsOnlyInSource, columnsOnlyInTarget, modifiedColumns });
    }
  }

  const sourceViews = new Set(source.views);
  const targetViews = new Set(target.views);
  const viewsOnlyInSource = source.views.filter(v => !targetViews.has(v));
  const viewsOnlyInTarget = target.views.filter(v => !sourceViews.has(v));

  const sourceProcs = new Set(source.procedures);
  const targetProcs = new Set(target.procedures);
  const proceduresOnlyInSource = source.procedures.filter(p => !targetProcs.has(p));
  const proceduresOnlyInTarget = target.procedures.filter(p => !sourceProcs.has(p));

  const targetTrigNames = new Set(target.triggers.map(t => t.name));
  const sourceTrigNames = new Set(source.triggers.map(t => t.name));
  const triggersOnlyInSource = source.triggers.filter(t => !targetTrigNames.has(t.name));
  const triggersOnlyInTarget = target.triggers.filter(t => !sourceTrigNames.has(t.name));

  return {
    tablesOnlyInSource,
    tablesOnlyInTarget,
    modifiedTables,
    viewsOnlyInSource,
    viewsOnlyInTarget,
    proceduresOnlyInSource,
    proceduresOnlyInTarget,
    triggersOnlyInSource,
    triggersOnlyInTarget,
  };
}

/** Renders a SchemaDiffResult as a human-readable text report */
export function renderDiffReport(
  diff: SchemaDiffResult,
  sourceLabel: string,
  targetLabel: string
): string {
  const lines: string[] = [];

  lines.push(`SCHEMA DIFF: ${sourceLabel}  →  ${targetLabel}`);
  lines.push('='.repeat(70));
  lines.push('');

  // Tables
  lines.push('── TABLES ──────────────────────────────────────────────────────────');
  if (diff.tablesOnlyInSource.length === 0 && diff.tablesOnlyInTarget.length === 0 && diff.modifiedTables.length === 0) {
    lines.push('  (no differences)');
  } else {
    for (const t of diff.tablesOnlyInSource) {
      lines.push(`  + ${t}  [only in source]`);
    }
    for (const t of diff.tablesOnlyInTarget) {
      lines.push(`  - ${t}  [only in target]`);
    }
    for (const t of diff.modifiedTables) {
      lines.push(`  ~ ${t.name}  [modified]`);
      for (const c of t.columnsOnlyInSource) {
        lines.push(`      + column: ${c.name} ${c.type}${c.length > 0 ? `(${c.length})` : ''}${c.notNull ? ' NOT NULL' : ''}`);
      }
      for (const c of t.columnsOnlyInTarget) {
        lines.push(`      - column: ${c.name} ${c.type}${c.length > 0 ? `(${c.length})` : ''}${c.notNull ? ' NOT NULL' : ''}`);
      }
      for (const m of t.modifiedColumns) {
        lines.push(`      ~ column: ${m.source.name}`);
        lines.push(`          source: ${m.source.type}(${m.source.length})${m.source.notNull ? ' NOT NULL' : ''}`);
        lines.push(`          target: ${m.target.type}(${m.target.length})${m.target.notNull ? ' NOT NULL' : ''}`);
      }
    }
  }
  lines.push('');

  // Views
  lines.push('── VIEWS ───────────────────────────────────────────────────────────');
  if (diff.viewsOnlyInSource.length === 0 && diff.viewsOnlyInTarget.length === 0) {
    lines.push('  (no differences)');
  } else {
    for (const v of diff.viewsOnlyInSource) {
      lines.push(`  + ${v}  [only in source]`);
    }
    for (const v of diff.viewsOnlyInTarget) {
      lines.push(`  - ${v}  [only in target]`);
    }
  }
  lines.push('');

  // Procedures
  lines.push('── STORED PROCEDURES ───────────────────────────────────────────────');
  if (diff.proceduresOnlyInSource.length === 0 && diff.proceduresOnlyInTarget.length === 0) {
    lines.push('  (no differences)');
  } else {
    for (const p of diff.proceduresOnlyInSource) {
      lines.push(`  + ${p}  [only in source]`);
    }
    for (const p of diff.proceduresOnlyInTarget) {
      lines.push(`  - ${p}  [only in target]`);
    }
  }
  lines.push('');

  // Triggers
  lines.push('── TRIGGERS ────────────────────────────────────────────────────────');
  if (diff.triggersOnlyInSource.length === 0 && diff.triggersOnlyInTarget.length === 0) {
    lines.push('  (no differences)');
  } else {
    for (const t of diff.triggersOnlyInSource) {
      lines.push(`  + ${t.name} ON ${t.table}  [only in source]`);
    }
    for (const t of diff.triggersOnlyInTarget) {
      lines.push(`  - ${t.name} ON ${t.table}  [only in target]`);
    }
  }
  lines.push('');
  lines.push('='.repeat(70));

  return lines.join('\n');
}

function columnsEqual(a: ColumnSnapshot, b: ColumnSnapshot): boolean {
  return a.type === b.type && a.length === b.length && a.notNull === b.notNull;
}

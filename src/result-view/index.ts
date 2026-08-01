import { Disposable, window } from "vscode";
import { TextDecoder } from "util";
import { join } from "path";

import { QueryResultsView, Message } from "./queryResultsView";
import { BatchResult, Driver, extractTableNames } from "../shared/driver";
import { getPrimaryKeyColumnsQuery } from "../shared/queries";
import { RowChange, buildStatementForChange } from "../shared/row-edit";
import { interpretPlanText, PlanInterpretation } from "../shared/plan-parser";
import { ActualPlanNode } from "../shared/actual-plan";
import { logger } from "../logger/logger";
import { getOptions } from "../config";

type ActualPlanResult = { nodes: ActualPlanNode[] } | { error: string };

type ResultSet = Array<any>;

/** Shape of a single result-set payload sent to the webview. */
export interface PreparedResultSet {
  /** Truncated to ~80 chars — display-only, used for the batch tab label. */
  sql: string;
  /** Untruncated statement text, used by the "🤖 Analyze" button so a long query isn't cut off mid-clause for the AI prompt. */
  fullSql: string;
  tableHeader: { title: string }[];
  tableBody: string[][];
  rowCount: number;
  durationMs: number;
  message?: string;
  error?: string;
  /** Table name auto-detected from the statement's FROM clause, pre-filled for row editing. */
  editableTable?: string;
  /**
   * Set when the server returned more rows than `firebird.maxResultRows` and the extra ones were
   * dropped before reaching the webview. Carries the *original* row count so the grid can say how
   * much is missing rather than just that something is.
   */
  truncatedFrom?: number;
}

/** Payload for the "applyChanges" message sent from the webview's edit toolbar. */
interface ApplyChangesRequest {
  requestId: string;
  tableName: string;
  columns: string[];
  changes: RowChange[];
}

/** Payload for the "analyzeResults" message sent from the webview's "🤖 Analyze" button. */
export interface AnalyzeResultsRequest {
  sql: string;
  headers: string[];
  rows: string[][];
}

/**
 * Payload for the "analyzePlan" message. Sent by both this webview's "Query Plan" tab (`sql`
 * always known -- the tab only exists alongside a specific statement) and, via the same
 * EventEmitter base, QueryPlanView's standalone panel (`sql` often unset -- see its own emit call
 * for why), so `sql` is optional here rather than required.
 */
export interface AnalyzePlanRequest {
  sql?: string;
  plan: string;
}

/** Payload for the "viewTableDiagram" message sent from the webview's "🗺 View Table Diagram" button. */
export interface ViewTableDiagramRequest {
  tableName: string;
}

export default class ResultView extends QueryResultsView implements Disposable {
  private resultSet?: ResultSet;
  private resultTableName?: string;
  private batchResults?: PreparedResultSet[];
  private recordsPerPage!: string;
  /** Keyed by statement SQL text, so switching back to an already-viewed "Query Plan" tab (or
   *  another statement that happens to share identical SQL) doesn't re-fetch. Cleared on every
   *  new display()/displayBatch() — a fresh set of results means any cached plan is stale. */
  private planCache = new Map<string, PlanInterpretation>();
  /** Same idea as planCache, for the "Actual Plan" tab (phase 3) — also avoids re-running the
   *  query (a real re-execution, not just a re-fetch) every time the user switches back to it. */
  private actualPlanCache = new Map<string, ActualPlanResult>();

  constructor(private extensionPath: string) {
    super("resultview", "Firebird Query Results", "table");
  }

  /** Display a single (legacy) result set. `tableName`, when known, pre-fills row editing. */
  display(resultSet: any, recordsPerPage: string, tableName?: string) {
    this.resultSet = resultSet;
    this.resultTableName = tableName;
    this.batchResults = undefined;
    this.recordsPerPage = recordsPerPage;
    this.planCache.clear();
    this.actualPlanCache.clear();
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  /** Display results from a batch run (multiple statements). */
  displayBatch(batchResults: BatchResult[], recordsPerPage: string) {
    this.batchResults = batchResults.map(r => this.prepareBatchResult(r));
    this.resultSet = undefined;
    this.recordsPerPage = recordsPerPage;
    this.planCache.clear();
    this.actualPlanCache.clear();
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "getData") {
      const { shortcuts, resultsFontSize, resultsFontFamily } = getOptions();
      if (this.batchResults) {
        this.send({
          command: "batchData",
          data: { results: this.batchResults, recordsPerPage: this.recordsPerPage, shortcuts, resultsFontSize, resultsFontFamily },
        });
      } else {
        const data = this.resultSet
          ? { ...this.getPreparedResults(), editableTable: this.resultTableName, shortcuts, resultsFontSize, resultsFontFamily }
          : { tableHeader: [], tableBody: [], recordsPerPage: this.recordsPerPage, shortcuts, resultsFontSize, resultsFontFamily };
        this.send({ command: "message", data });
      }
      return;
    }

    if (message.command === "getPrimaryKey") {
      this.handleGetPrimaryKey(message.data as { requestId: string; tableName: string });
      return;
    }

    if (message.command === "applyChanges") {
      this.handleApplyChanges(message.data as ApplyChangesRequest);
      return;
    }

    if (message.command === "analyzeResults") {
      // Delegated to extension.ts (which owns the Copilot/schema-provider wiring) via this
      // EventEmitter base class, the same way this whole class avoids depending on src/copilot
      // directly.
      this.emit("analyzeResults", message.data as AnalyzeResultsRequest);
      return;
    }

    if (message.command === "getQueryPlan") {
      this.handleGetQueryPlan(message.data as { requestId: string; sql: string });
      return;
    }

    if (message.command === "analyzePlan") {
      // Same delegation pattern as "analyzeResults" above -- the "🤖 Analyze" button inside a
      // "Query Plan" tab (phase 6, docs/roadmap/query-plan-visualizer.md).
      this.emit("analyzePlan", message.data as AnalyzePlanRequest);
      return;
    }

    if (message.command === "getActualPlan") {
      this.handleGetActualPlan(message.data as { requestId: string; sql: string });
      return;
    }

    if (message.command === "viewTableDiagram") {
      // "🗺 View Table Diagram" (docs/roadmap/query-results-enhancements.md, phase 5). Delegated
      // to extension.ts, the same as "analyzeResults"/"analyzePlan" above -- it owns the shared
      // SchemaDesigner instance, and this view only ever knows a table *name*, not a
      // ConnectionOptions to open it against (that comes from Global.activeConnection on the
      // extension-host side, the same source row editing's own applyChanges() already resolves
      // its connection from).
      this.emit("viewTableDiagram", message.data as ViewTableDiagramRequest);
      return;
    }
  }

  /**
   * Phase 4 of docs/roadmap/query-plan-visualizer.md — the per-statement "Query Plan" tab, as an
   * alternative to opening the standalone QueryPlanView panel via firebird.showEstimatedPlan.
   * Fetches/parses through the exact same interpretPlanText() path that panel uses, so the two
   * surfaces render identically for the same plan.
   */
  private async handleGetQueryPlan(data: { requestId: string; sql: string }): Promise<void> {
    const { requestId, sql } = data;
    let result = this.planCache.get(sql);
    if (!result) {
      try {
        const planText = await Driver.getQueryPlan(sql);
        result = interpretPlanText(planText);
      } catch (err: any) {
        result = { error: err?.message ?? String(err), raw: "" };
      }
      this.planCache.set(sql, result);
    }
    this.send({ command: "queryPlanResult", data: { requestId, ...result } });
  }

  /**
   * "Actual Plan" (phase 3) — re-runs the statement for real via Driver.getActualPlan() to
   * collect Firebird 5.0+'s RDB$PROFILER per-record-source stats. Distinct cache from
   * planCache/getQueryPlan above: a different data shape (ActualPlanNode[], not PlanNode[]) and a
   * genuinely different cost to repeat (a live re-execution, not just a re-parse).
   */
  private async handleGetActualPlan(data: { requestId: string; sql: string }): Promise<void> {
    const { requestId, sql } = data;
    let result = this.actualPlanCache.get(sql);
    if (!result) {
      try {
        const nodes = await Driver.getActualPlan(sql);
        result = { nodes };
      } catch (err: any) {
        result = { error: err?.message ?? String(err) };
      }
      this.actualPlanCache.set(sql, result);
    }
    this.send({ command: "actualPlanResult", data: { requestId, ...result } });
  }

  /** Looks up a table's primary key columns, for targeting UPDATE/DELETE at a single row. */
  private async handleGetPrimaryKey(data: { requestId: string; tableName: string }): Promise<void> {
    const columns = await this.fetchPrimaryKeyColumns(data.tableName);
    this.send({ command: "primaryKey", data: { requestId: data.requestId, columns } });
  }

  private async fetchPrimaryKeyColumns(tableName: string): Promise<string[]> {
    if (!tableName) {
      return [];
    }
    try {
      const rows = await Driver.runQuery(getPrimaryKeyColumnsQuery(tableName));
      return (rows ?? []).map((r: any) => (r.FIELD_NAME ?? "").toString().trim()).filter(Boolean);
    } catch (err) {
      logger.error(err);
      return [];
    }
  }

  /**
   * Builds and executes the SQL for a batch of pending row edits (update/insert/delete),
   * after an explicit confirmation, and reports the outcome via a native notification.
   */
  private async handleApplyChanges(data: ApplyChangesRequest): Promise<void> {
    const { requestId, tableName, columns, changes } = data;

    if (!tableName) {
      logger.showError("Enter a table name before applying changes.");
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }
    if (!changes || changes.length === 0) {
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }

    const counts = { update: 0, insert: 0, delete: 0 };
    changes.forEach(c => counts[c.type]++);
    const summary = ([
      counts.update ? `${counts.update} update(s)` : null,
      counts.insert ? `${counts.insert} insert(s)` : null,
      counts.delete ? `${counts.delete} delete(s)` : null,
    ].filter(Boolean) as string[]).join(", ");

    const answer = await window.showWarningMessage(
      `Apply ${summary} to ${tableName}?`,
      { modal: true },
      "Apply"
    );
    if (answer !== "Apply") {
      this.send({ command: "applyResult", data: { requestId, cancelled: true } });
      return;
    }

    const pkColumns = await this.fetchPrimaryKeyColumns(tableName);

    const results: { changeIndex: number; sql: string; error?: string }[] = [];
    for (let i = 0; i < changes.length; i++) {
      let sql = "";
      try {
        sql = buildStatementForChange(tableName, columns, pkColumns, changes[i]);
        await Driver.runQuery(sql);
        results.push({ changeIndex: i, sql });
      } catch (err: any) {
        results.push({ changeIndex: i, sql, error: err?.message ?? String(err) });
        logger.error(`Row edit failed: ${sql || "(could not build statement)"} -> ${err?.message ?? err}`);
      }
    }

    const failed = results.filter(r => r.error);
    if (failed.length === 0) {
      logger.showInfo(`Applied ${results.length} change(s) to ${tableName}. Re-run the query to see the updated data.`);
    } else {
      logger.showError(
        `${failed.length} of ${results.length} change(s) to ${tableName} failed. Check logs for details.`,
        ["Show Logs"]
      ).then(sel => {
        if (sel === "Show Logs") {
          logger.showOutput();
        }
      });
    }

    this.send({ command: "applyResult", data: { requestId, results } });
  }

  /* prepare results before displaying */
  private getPreparedResults(): object {
    const decoder = new TextDecoder();
    const tableHeader: object[] = [];
    const tableBody: string[][] = [];

    if (!this.resultSet || this.resultSet.length === 0) {
      return { tableHeader: [], tableBody: [], recordsPerPage: this.recordsPerPage };
    }
    for (const field in this.resultSet[0]) {
      if (Object.prototype.hasOwnProperty.call(this.resultSet[0], field)) {
        tableHeader.push({ title: field });
      }
    }
    const capped = capRows(this.resultSet, getOptions().maxResultRows);
    capped.rows.forEach((row: any) => {
      tableBody.push(encodeRow(row, decoder));
    });
    return { tableHeader, tableBody, recordsPerPage: this.recordsPerPage, truncatedFrom: capped.truncatedFrom };
  }

  private prepareBatchResult(r: BatchResult): PreparedResultSet {
    const decoder = new TextDecoder();
    const editableTable = extractTableNames(r.sql)[0];
    const fullSql = r.sql.replace(/\s+/g, " ").trim();
    const sql = fullSql.length > 80 ? fullSql.slice(0, 77) + "..." : fullSql;

    if (r.error) {
      return { sql, fullSql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, error: r.error };
    }
    if (r.message || !r.rows || r.rows.length === 0) {
      return { sql, fullSql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, message: r.message };
    }

    const tableHeader = Object.keys(r.rows[0]).map(f => ({ title: f }));
    const capped = capRows(r.rows, getOptions().maxResultRows);
    const tableBody = capped.rows.map((row: any) => encodeRow(row, decoder));
    // rowCount stays the number of rows actually shown, so the grid's own count never disagrees
    // with what is in it; `truncatedFrom` is what tells the user rows were dropped.
    return { sql, fullSql, tableHeader, tableBody, rowCount: capped.rows.length, durationMs: r.durationMs, editableTable, truncatedFrom: capped.truncatedFrom };
  }
}

/**
 * Applies the `firebird.maxResultRows` cap to a set of already-fetched rows.
 *
 * Worth being precise about what this is and is not: the pure-JS driver returns a whole result
 * set in a single callback, with no streaming loop to stop, so for arbitrary user SQL the server
 * has already produced every row by the time this runs. Capping here bounds what crosses into the
 * webview — which is what actually falls over on a large table — but it does not save the server
 * or the driver any work. The genuine server-side limit is `selectAllRecordsQuery()`'s FIRST
 * clause, which only applies where the extension writes the query itself.
 */
export function capRows<T>(rows: T[], maxRows: number): { rows: T[]; truncatedFrom?: number } {
  if (!Number.isInteger(maxRows) || maxRows <= 0 || rows.length <= maxRows) {
    return { rows };
  }
  return { rows: rows.slice(0, maxRows), truncatedFrom: rows.length };
}

function encodeRow(row: any, decoder: TextDecoder): string[] {
  return Object.keys(row).map(field => {
    const v = row[field];
    if (v === null || v === undefined) { return "&lt;null&gt;"; }
    if (v instanceof Buffer) { return decoder.decode(v); }
    if (Object.prototype.toString.call(v) === "[object Date]") { return new Date(v).toLocaleDateString(); }
    if (typeof v === "object") { return JSON.stringify(v, null, "\t"); }
    return v.toString();
  });
}

import { Disposable } from "vscode";
import { TextDecoder } from "util";
import { join } from "path";

import { QueryResultsView, Message } from "./queryResultsView";
import { BatchResult } from "../shared/driver";

type ResultSet = Array<any>;

/** Shape of a single result-set payload sent to the webview. */
export interface PreparedResultSet {
  sql: string;
  tableHeader: { title: string }[];
  tableBody: string[][];
  rowCount: number;
  durationMs: number;
  message?: string;
  error?: string;
}

export default class ResultView extends QueryResultsView implements Disposable {
  private resultSet?: ResultSet;
  private batchResults?: PreparedResultSet[];
  private recordsPerPage: string;

  constructor(private extensionPath: string) {
    super("resultview", "Firebird Query Results");
  }

  /** Display a single (legacy) result set. */
  display(resultSet: any, recordsPerPage: string) {
    this.resultSet = resultSet;
    this.batchResults = undefined;
    this.recordsPerPage = recordsPerPage;
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  /** Display results from a batch run (multiple statements). */
  displayBatch(batchResults: BatchResult[], recordsPerPage: string) {
    this.batchResults = batchResults.map((r, i) => this.prepareBatchResult(r, i));
    this.resultSet = undefined;
    this.recordsPerPage = recordsPerPage;
    this.show(join(this.extensionPath, "src", "result-view", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "getData") {
      if (this.batchResults) {
        this.send({
          command: "batchData",
          data: { results: this.batchResults, recordsPerPage: this.recordsPerPage },
        });
      } else {
        const data = this.resultSet ? this.getPreparedResults() : { tableHeader: [], tableBody: [], recordsPerPage: this.recordsPerPage };
        this.send({ command: "message", data });
      }
      return;
    }

    if (message.command === "generateUpdate") {
      const { tableName, originalRow, changedFields, columns } = message.data as any;
      const updateSql = this.buildUpdateSql(tableName, originalRow, changedFields, columns);
      this.send({ command: "updateSql", data: { sql: updateSql } });
      return;
    }
  }

  /** Build a best-effort UPDATE statement from an edited row. */
  private buildUpdateSql(
    tableName: string,
    originalRow: string[],
    changedFields: { colIndex: number; newValue: string }[],
    columns: string[]
  ): string {
    if (!tableName || changedFields.length === 0) {
      return "-- No table name or changes detected.";
    }
    // Validate table name: only allow identifiers (letters, digits, $, _)
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tableName)) {
      return "-- Invalid table name. Only alphanumeric identifiers are allowed.";
    }
    // Validate column names the same way
    const invalidCol = columns.find(c => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c));
    if (invalidCol) {
      return `-- Invalid column name: ${invalidCol}`;
    }
    const setClauses = changedFields
      .map(cf => `  ${columns[cf.colIndex]} = ${quoteValue(cf.newValue)}`)
      .join(",\n");

    const whereClauses = columns
      .map((col, i) => `  ${col} = ${quoteValue(originalRow[i])}`)
      .join("\n  AND ");

    return `UPDATE ${tableName}\n   SET\n${setClauses}\n WHERE\n  ${whereClauses};`;
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
    this.resultSet.forEach(row => {
      tableBody.push(encodeRow(row, decoder));
    });
    return { tableHeader, tableBody, recordsPerPage: this.recordsPerPage };
  }

  private prepareBatchResult(r: BatchResult, index: number): PreparedResultSet {
    const decoder = new TextDecoder();
    const label = r.sql.replace(/\s+/g, " ").trim();
    const sql = label.length > 80 ? label.slice(0, 77) + "..." : label;

    if (r.error) {
      return { sql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, error: r.error };
    }
    if (r.message || !r.rows || r.rows.length === 0) {
      return { sql, tableHeader: [], tableBody: [], rowCount: 0, durationMs: r.durationMs, message: r.message };
    }

    const tableHeader = Object.keys(r.rows[0]).map(f => ({ title: f }));
    const tableBody = r.rows.map(row => encodeRow(row, decoder));
    return { sql, tableHeader, tableBody, rowCount: r.rows.length, durationMs: r.durationMs };
  }
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

function quoteValue(v: string): string {
  if (v === "&lt;null&gt;" || v === "<null>") { return "NULL"; }
  const n = Number(v);
  if (!isNaN(n) && v.trim() !== "") { return v; }
  return `'${v.replace(/'/g, "''")}'`;
}

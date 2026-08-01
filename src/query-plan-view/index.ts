import * as vscode from "vscode";
import { join } from "path";
import { readFile } from "fs/promises";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { interpretPlanText } from "../shared/plan-parser";
import { logger } from "../logger/logger";

/**
 * Graphical execution-plan viewer: parses Firebird's legacy `PLAN (...)` syntax
 * (`src/shared/plan-parser.ts`) and renders it as a node diagram, in place of dumping the plan
 * as plain text into an editor (which `firebird.explainPlan` still does, unchanged). Phases 2, 4,
 * 5, and 6 of `docs/roadmap/query-plan-visualizer.md` are done — phase 4's result-view tab
 * integration lives in `ResultView`'s "Query Plan" tab; this standalone panel remains for the
 * dedicated `firebird.showEstimatedPlan` command. No actual-plan monitoring overlay yet (see that
 * doc for what's deferred and why).
 */
export class QueryPlanView extends QueryResultsView implements vscode.Disposable {
  private sql?: string;
  private dbDetails?: ConnectionOptions;
  /** The most recently successfully rendered plan's raw text — what the "🤖 Analyze" toolbar
   *  button sends to Copilot. Cleared on error so Analyze isn't offered for a plan that isn't
   *  actually showing (the webview mirrors this by only enabling the button on a successful
   *  planData message). */
  private lastRawPlan?: string;

  constructor(private readonly extensionPath: string) {
    super("queryplanview", "Firebird Query Plan", "graph");
  }

  /** Both args are optional — Driver.getQueryPlan() resolves from the active editor/active connection itself, same as firebird.explainPlan. */
  open(sql?: string, dbDetails?: ConnectionOptions): void {
    this.sql = sql;
    this.dbDetails = dbDetails;
    this.lastRawPlan = undefined;
    super.show(join(this.extensionPath, "src", "query-plan-view", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    if (message.command === "ready" || message.command === "refresh") {
      this.fetchAndSend().catch(err => logger.error(err));
    }
    if (message.command === "importPlan") {
      this.importFromFile().catch(err => logger.error(err));
    }
    if (message.command === "analyzePlan") {
      this.emitAnalyzePlan();
    }
    if (message.command === "getActualPlan") {
      this.fetchActualPlan().catch(err => logger.error(err));
    }
  }

  /**
   * "Copilot 'Analyze' action" (phase 6) — delegated to extension.ts (which owns the Copilot
   * wiring) via this EventEmitter base, the same pattern ResultView's "analyzeResults" already
   * uses, rather than a direct src/copilot import here. `sql` is whatever open() was given
   * explicitly (usually nothing — firebird.showEstimatedPlan calls open() with no args); when
   * unset, runAnalyzePlanAction() falls back to the active SQL editor itself.
   */
  private emitAnalyzePlan(): void {
    if (!this.lastRawPlan) {
      logger.showError("No query plan to analyze yet.");
      return;
    }
    this.emit("analyzePlan", { sql: this.sql, plan: this.lastRawPlan });
  }

  private async fetchAndSend(): Promise<void> {
    let planText: string;
    try {
      planText = await Driver.getQueryPlan(this.sql, this.dbDetails);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Query plan view failed: ${message}`);
      this.lastRawPlan = undefined;
      this.send({ command: "planData", data: { error: message } });
      return;
    }
    this.parseAndSend(planText);
  }

  /**
   * "Import a saved plan" (phase 5): loads a plan previously saved as plain text (e.g. copied
   * from `firebird.explainPlan`'s output, or `isql`'s `SET PLANONLY ON`) and renders it with no
   * live connection needed — reuses the exact same parse/fallback-detection path as a live fetch
   * so an imported plan behaves identically to one just fetched.
   */
  private async importFromFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: "Import Query Plan",
      canSelectMany: false,
      filters: { "Plan / Text": ["txt", "plan", "sql"], "All files": ["*"] },
    });
    if (!uris || uris.length === 0) {
      return;
    }
    const filePath = uris[0].fsPath;
    let planText: string;
    try {
      planText = await readFile(filePath, "utf8");
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Query plan import failed: ${message}`);
      this.lastRawPlan = undefined;
      this.send({ command: "planData", data: { error: `Couldn't read the file: ${message}` } });
      return;
    }
    this.parseAndSend(planText, filePath);
  }

  /**
   * "Actual Plan" (phase 3) — re-runs the query for real via Driver.getActualPlan() and sends
   * back the per-record-source tree from Firebird 5.0+'s RDB$PROFILER, distinct from the
   * estimated blocks/diagram data ("planData") above. Lazy: only fetched when the webview's
   * "Actual" view-mode button is clicked, not on every "ready"/"refresh".
   */
  private async fetchActualPlan(): Promise<void> {
    try {
      const nodes = await Driver.getActualPlan(this.sql, this.dbDetails);
      this.send({ command: "actualPlanData", data: { nodes } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`Actual plan fetch failed: ${message}`);
      this.send({ command: "actualPlanData", data: { error: message } });
    }
  }

  /** Shared by both a live fetch and a file import: fallback-text detection, parsing, and error reporting. */
  private parseAndSend(planText: string, importedFrom?: string): void {
    const result = interpretPlanText(planText);
    if ("error" in result) {
      this.lastRawPlan = undefined;
      this.send({ command: "planData", data: { error: result.error, raw: result.raw } });
      return;
    }
    this.lastRawPlan = result.raw;
    this.send({ command: "planData", data: { blocks: result.blocks, raw: result.raw, importedFrom } });
  }
}

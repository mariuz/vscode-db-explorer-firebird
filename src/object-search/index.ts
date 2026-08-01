import { window, QuickPickItem, QuickInputButton, QuickInputButtonLocation, ThemeIcon } from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { getOptions } from "../config";
import {
  getTablesQuery, getViewsQuery, getStoredProceduresQuery, getTriggersQuery,
  getGeneratorsQuery, getDomainsQuery, generatorCurrentValueQuery, getSystemTablesQuery,
} from "../shared/queries";
import { NodeTable, NodeView, NodeProcedure, NodeTrigger, NodeDomain } from "../nodes";
import { buildSearchIndex, kindLabel, describeResult, mergeSystemResults, SearchResult } from "./search-model";
import { logger } from "../logger/logger";
import type QueryResultsView from "../result-view";

interface SearchQuickPickItem extends QuickPickItem {
  result: SearchResult;
}

/**
 * Fuzzy-searches every table/view/procedure/trigger/generator/domain in a connection by name
 * (VS Code's own QuickPick filtering already fuzzy-matches as you type) and jumps straight to
 * that object's most useful existing action — reusing NodeTable/NodeView/.../s own methods rather
 * than duplicating their logic, so there's exactly one place each object type's "primary action"
 * is implemented.
 */
export async function runObjectSearch(connectionOptions: ConnectionOptions, firebirdQueryResults: QueryResultsView): Promise<void> {
  const sql = [
    getTablesQuery(0), getViewsQuery(), getStoredProceduresQuery(), getTriggersQuery(), getGeneratorsQuery(), getDomainsQuery(),
  ].join("\n");

  let results;
  try {
    results = await Driver.runBatch(sql, connectionOptions);
  } catch (err: any) {
    logger.error(`Object Search failed: ${err?.message ?? err}`);
    logger.showError(`Could not search objects: ${err?.message ?? err}`);
    return;
  }

  for (const r of results) {
    if (r?.error) {
      logger.showError(`Could not search objects: ${r.error}`);
      return;
    }
  }
  const [tablesResult, viewsResult, proceduresResult, triggersResult, generatorsResult, domainsResult] = results;

  const index = buildSearchIndex({
    tables: tablesResult?.rows ?? [],
    views: viewsResult?.rows ?? [],
    procedures: proceduresResult?.rows ?? [],
    triggers: triggersResult?.rows ?? [],
    generators: generatorsResult?.rows ?? [],
    domains: domainsResult?.rows ?? [],
  });

  if (index.length === 0) {
    logger.showInfo("No tables, views, procedures, triggers, generators, or domains found in this database.");
    return;
  }

  const items: SearchQuickPickItem[] = index.map(result => ({
    label: result.name,
    description: kindLabel(result.kind),
    result,
  }));

  const picked = await pickObject(items, connectionOptions);
  if (!picked) {
    return;
  }

  await runPrimaryAction(picked.result, connectionOptions, firebirdQueryResults);
}


/**
 * The search picker.
 *
 * Built with `createQuickPick()` rather than `showQuickPick()` for two things the simple API
 * cannot express: a persistent `prompt` under the input (VS Code 1.108) saying what is being
 * searched and how to act on a result, and an inline **toggle** button (1.109) for system tables.
 *
 * The toggle exists because system objects are excluded in SQL, not in the UI — every listing
 * query filters on `RDB$SYSTEM_FLAG`. Turning it on runs one extra query and merges the results,
 * so it is a live re-index rather than a client-side filter. Scope worth being precise about: it
 * adds system *tables*, the only system category with an existing query; system triggers,
 * procedures and domains are not included.
 */
async function pickObject(
  items: SearchQuickPickItem[],
  connectionOptions: ConnectionOptions
): Promise<SearchQuickPickItem | undefined> {
  const systemTablesToggle: QuickInputButton = {
    iconPath: new ThemeIcon("gear"),
    tooltip: "Include system tables",
    location: QuickInputButtonLocation.Inline,
    toggle: { checked: false },
  };

  const picker = window.createQuickPick<SearchQuickPickItem>();
  picker.title = "Search Objects";
  picker.placeholder = "Search tables, views, procedures, triggers, generators, and domains by name...";
  picker.prompt = "Matches on name and type. Enter opens the object's primary action.";
  picker.matchOnDescription = true;
  picker.items = items;
  picker.buttons = [systemTablesToggle];

  let systemResults: SearchResult[] | undefined;

  try {
    return await new Promise<SearchQuickPickItem | undefined>(resolve => {
      picker.onDidTriggerButton(async button => {
        if (button !== systemTablesToggle) { return; }
        if (!systemTablesToggle.toggle?.checked) {
          picker.items = items;
          return;
        }
        // Fetched once and remembered: toggling repeatedly should not re-query.
        if (!systemResults) {
          picker.busy = true;
          try {
            systemResults = await loadSystemTableResults(connectionOptions);
          } catch (err: any) {
            logger.showError(`Could not load system tables: ${err?.message ?? err}`);
            systemResults = [];
          } finally {
            picker.busy = false;
          }
        }
        const system = new Set(systemResults);
        picker.items = mergeSystemResults(items.map(i => i.result), systemResults).map(result => ({
          label: result.name,
          description: describeResult(result, system.has(result)),
          result,
        }));
      });
      picker.onDidAccept(() => resolve(picker.selectedItems[0]));
      picker.onDidHide(() => resolve(undefined));
      picker.show();
    });
  } finally {
    picker.dispose();
  }
}

/** System tables as search results — see pickObject() for why this is a separate, on-demand query. */
async function loadSystemTableResults(connectionOptions: ConnectionOptions): Promise<SearchResult[]> {
  const [result] = await Driver.runBatch(getSystemTablesQuery(), connectionOptions);
  if (result?.error) {
    throw new Error(result.error);
  }
  return buildSearchIndex({
    tables: result?.rows ?? [], views: [], procedures: [], triggers: [], generators: [], domains: [],
  });
}

/** Table/view -> select all records (into the results grid); procedure/trigger/domain -> open an editable ALTER scaffold; generator -> a read-only current-value peek (it has no other non-destructive inspection action). */
async function runPrimaryAction(
  result: SearchResult, connectionOptions: ConnectionOptions, firebirdQueryResults: QueryResultsView
): Promise<void> {
  try {
    switch (result.kind) {
      case "TABLE": {
        const node = new NodeTable(connectionOptions, result.name);
        const rows = await node.selectAllRecords();
        firebirdQueryResults.display(rows, getOptions().recordsPerPage, result.name);
        return;
      }
      case "VIEW": {
        const node = new NodeView(connectionOptions, result.name);
        const rows = await node.selectAllRecords();
        firebirdQueryResults.display(rows, getOptions().recordsPerPage, result.name);
        return;
      }
      case "PROCEDURE": {
        const node = new NodeProcedure(connectionOptions, result.name);
        await node.editProcedure();
        return;
      }
      case "TRIGGER": {
        const node = new NodeTrigger(result.row, connectionOptions);
        await node.editTrigger();
        return;
      }
      case "DOMAIN": {
        const node = new NodeDomain(result.row, connectionOptions);
        await node.alterDomain();
        return;
      }
      case "GENERATOR": {
        const rows = await Driver.runQuery(generatorCurrentValueQuery(result.name), connectionOptions);
        firebirdQueryResults.display(rows, getOptions().recordsPerPage);
        return;
      }
    }
  } catch (err: any) {
    logger.error(`Object Search action failed: ${err?.message ?? err}`);
    logger.showError(`Could not open ${result.name}: ${err?.message ?? err}`);
  }
}

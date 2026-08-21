import {
  ExtensionContext, ViewColumn, WebviewPanel, window, Uri, env, commands
} from "vscode";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import {
  tableInfoQuery, getObjectPrivilegesQuery, getViewDefinitionQuery, getProcedureBodyQuery,
  getTriggerBodyQuery, generatorCurrentValueQuery
} from "../shared/queries";
import {
  buildViewCreateDDL, buildProcedureCreateDDL, buildTriggerCreateDDL,
  buildGeneratorCreateDDL, buildDomainCreateDDL, buildExceptionCreateDDL, buildRoleCreateDDL
} from "../database-projects/project-model";
import { normalizeDefault } from "../schema-designer/schema-graph";
import { logger } from "../logger/logger";

export interface ObjectPropertiesTarget {
  name: string;
  type: "table" | "view" | "procedure" | "trigger" | "generator" | "domain" | "role" | "exception";
  schema?: string;
  dbDetails: ConnectionOptions;
}

let currentPanel: WebviewPanel | undefined;

export async function showObjectProperties(
  targetNode: any,
  context: ExtensionContext
): Promise<void> {
  const target = resolveTarget(targetNode);
  if (!target || !target.dbDetails) {
    window.showErrorMessage("Could not inspect properties: Invalid database object selected.");
    return;
  }

  const title = `Properties: ${target.name} (${target.type.toUpperCase()})`;
  if (currentPanel) {
    currentPanel.title = title;
    currentPanel.reveal(ViewColumn.Beside);
  } else {
    currentPanel = window.createWebviewPanel(
      "firebirdObjectProperties",
      title,
      ViewColumn.Beside,
      // Ctrl+F: this panel is mostly a DDL listing and a grants table, which is exactly the
      // kind of content someone searches rather than scrolls.
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    });
  }

  currentPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === "copyDdl") {
      await env.clipboard.writeText(msg.ddl);
      window.showInformationMessage("DDL copied to clipboard.");
    }
  });

  currentPanel.webview.html = getLoadingHtml(target.name, target.type);

  try {
    const data = await fetchObjectMetadata(target);
    currentPanel.webview.html = buildPropertiesHtml(target, data);
  } catch (err: any) {
    logger.error(`Failed to fetch object properties: ${err?.message ?? err}`);
    if (currentPanel) {
      currentPanel.webview.html = getErrorHtml(target.name, String(err?.message ?? err));
    }
  }
}

export function resolveTarget(node: any): ObjectPropertiesTarget | undefined {
  if (!node) return undefined;

  // Table Node
  if (typeof node.getTableName === "function") {
    return {
      name: node.getTableName(),
      type: "table",
      dbDetails: node.getDbDetails ? node.getDbDetails() : node.dbDetails,
    };
  }
  // View Node
  if (typeof node.getViewName === "function") {
    return {
      name: node.getViewName(),
      type: "view",
      dbDetails: node.getDbDetails ? node.getDbDetails() : node.dbDetails,
    };
  }
  // Procedure Node
  if (typeof node.getProcedureName === "function") {
    return {
      name: node.getProcedureName(),
      type: "procedure",
      dbDetails: node.dbDetails,
    };
  }
  // Trigger Node
  if (node.trigger) {
    return {
      name: node.trigger.TRIGGER_NAME ? String(node.trigger.TRIGGER_NAME).trim() : "TRIGGER",
      type: "trigger",
      dbDetails: node.dbDetails,
    };
  }
  // Generator / Sequence Node
  if (typeof node.getGeneratorName === "function") {
    return {
      name: node.getGeneratorName(),
      type: "generator",
      dbDetails: node.dbDetails,
    };
  }
  // Domain Node
  if (node.domain) {
    return {
      name: node.domain.DOMAIN_NAME ? String(node.domain.DOMAIN_NAME).trim() : "DOMAIN",
      type: "domain",
      dbDetails: node.dbDetails,
    };
  }
  // Role Node
  if (node.roleName) {
    return {
      name: String(node.roleName).trim(),
      type: "role",
      dbDetails: node.dbDetails,
    };
  }
  // Exception Node
  if (node.exception || typeof node.getExceptionName === "function") {
    return {
      name: node.getExceptionName ? node.getExceptionName() : String(node.exception?.EXCEPTION_NAME ?? "").trim(),
      type: "exception",
      dbDetails: node.dbDetails,
    };
  }

  return undefined;
}

export interface FetchedMetadata {
  columns: any[];
  privileges: any[];
  ddl: string;
  indexes: any[];
}

async function fetchObjectMetadata(target: ObjectPropertiesTarget): Promise<FetchedMetadata> {
  const db = target.dbDetails;
  let columns: any[] = [];
  let privileges: any[] = [];
  let ddl = "";
  let indexes: any[] = [];

  // Fetch privileges for all supported objects
  try {
    const privRows = await Driver.runQuery(getObjectPrivilegesQuery(target.name), db);
    privileges = Array.isArray(privRows) ? privRows : [];
  } catch {
    privileges = [];
  }

  if (target.type === "table") {
    try {
      const colRows = await Driver.runQuery(tableInfoQuery(target.name, target.schema), db);
      columns = Array.isArray(colRows) ? colRows : [];
      // Derive indexes/constraints from tableInfoQuery
      indexes = columns.filter(c => c.INDEX_NAME).map(c => ({
        NAME: c.INDEX_NAME,
        TYPE: c.CONSTRAINT_TYPE || "INDEX",
        FIELD: c.FIELD_NAME,
      }));
      ddl = generateTableDDL(target.name, columns);
    } catch (err) {
      logger.error(`Error fetching table metadata: ${err}`);
    }
  } else if (target.type === "view") {
    try {
      const viewRows = await Driver.runQuery(getViewDefinitionQuery(target.name, target.schema), db);
      const source = (viewRows && viewRows[0]) ? (viewRows[0].RDB$VIEW_SOURCE || viewRows[0].SOURCE || "") : "";
      ddl = buildViewCreateDDL({ name: target.name, source });
    } catch {
      ddl = `CREATE VIEW ${target.name} AS SELECT * FROM ...;`;
    }
  } else if (target.type === "procedure") {
    try {
      const procRows = await Driver.runQuery(getProcedureBodyQuery(target.name), db);
      const source = (procRows && procRows[0]) ? (procRows[0].RDB$PROCEDURE_SOURCE || "") : "";
      ddl = `CREATE OR ALTER PROCEDURE ${target.name}\nAS\n${source};`;
    } catch {
      ddl = `CREATE PROCEDURE ${target.name} AS ...;`;
    }
  } else if (target.type === "trigger") {
    try {
      const trigRows = await Driver.runQuery(getTriggerBodyQuery(target.name), db);
      const source = (trigRows && trigRows[0]) ? (trigRows[0].RDB$TRIGGER_SOURCE || "") : "";
      const table = (trigRows && trigRows[0]) ? (trigRows[0].RDB$RELATION_NAME || "TABLE").trim() : "TABLE";
      ddl = `CREATE OR ALTER TRIGGER ${target.name} FOR ${table}\nBEFORE INSERT AS\n${source};`;
    } catch {
      ddl = `CREATE TRIGGER ${target.name} FOR TABLE ...;`;
    }
  } else if (target.type === "generator") {
    try {
      const valRows = await Driver.runQuery(generatorCurrentValueQuery(target.name), db);
      const val = (valRows && valRows[0]) ? Object.values(valRows[0])[0] : 0;
      ddl = `${buildGeneratorCreateDDL(target.name)}\nSET GENERATOR ${target.name} TO ${val};`;
    } catch {
      ddl = buildGeneratorCreateDDL(target.name);
    }
  } else if (target.type === "domain") {
    ddl = `CREATE DOMAIN ${target.name} AS VARCHAR(255);`;
  } else if (target.type === "role") {
    ddl = buildRoleCreateDDL({ name: target.name });
  } else if (target.type === "exception") {
    ddl = buildExceptionCreateDDL({ name: target.name, message: "Custom Exception" });
  }

  return { columns, privileges, ddl, indexes };
}

export function generateTableDDL(tableName: string, columns: any[]): string {
  if (!columns || columns.length === 0) {
    return `CREATE TABLE ${tableName} (\n  -- No column metadata found\n);`;
  }
  const lines = columns.map(c => {
    const typeStr = `${c.FIELD_TYPE}${c.FIELD_LENGTH ? `(${c.FIELD_LENGTH})` : ""}`;
    const notNullStr = c.NOT_NULL ? " NOT NULL" : "";
    // RDB$DEFAULT_SOURCE -- which is what tableInfoQuery() selects as DFLT_VALUE -- already
    // *includes* the DEFAULT keyword ("DEFAULT 0"), so prefixing another one produced
    // `DEFAULT DEFAULT 0`: invalid DDL, shown in the DDL Source tab and handed out by Copy DDL.
    // normalizeDefault() is the same helper script-as/ddl-builders.ts already applies to this
    // exact column, and every other DDL builder in the codebase goes through it.
    const dflt = normalizeDefault(c.DFLT_VALUE);
    const dfltStr = dflt ? ` DEFAULT ${dflt}` : "";
    return `  ${c.FIELD_NAME} ${typeStr}${dfltStr}${notNullStr}`;
  });
  return `CREATE TABLE ${tableName} (\n${lines.join(",\n")}\n);`;
}

export function getLoadingHtml(name: string, type: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); padding: 20px; }
  .spinner { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid var(--vscode-progressBar-background, #007acc); border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 10px; }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h2><span class="spinner"></span> Loading properties for ${escapeHtml(name)} (${escapeHtml(type).toUpperCase()})...</h2>
</body>
</html>`;
}

export function getErrorHtml(name: string, error: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); padding: 20px; }
  .error { color: var(--vscode-errorForeground, #f48771); background: rgba(244,135,113,0.1); padding: 12px; border-radius: 4px; border-left: 4px solid #f48771; }
</style>
</head>
<body>
  <h2>Object Properties: ${escapeHtml(name)}</h2>
  <div class="error"><strong>Error loading metadata:</strong> ${escapeHtml(error)}</div>
</body>
</html>`;
}

export function buildPropertiesHtml(target: ObjectPropertiesTarget, data: FetchedMetadata): string {
  const columnsRows = data.columns.map(c => `
    <tr>
      <td><strong>${escapeHtml(c.FIELD_NAME || "")}</strong></td>
      <td><code>${escapeHtml(c.FIELD_TYPE || "")}${c.FIELD_LENGTH ? `(${c.FIELD_LENGTH})` : ""}</code></td>
      <td>${c.NOT_NULL ? "✓ NOT NULL" : "NULL"}</td>
      <td><code>${escapeHtml(c.DFLT_VALUE || "-")}</code></td>
      <td>${escapeHtml(c.CONSTRAINT_TYPE || "-")}</td>
    </tr>
  `).join("");

  const privRows = data.privileges.map(p => `
    <tr>
      <td>${escapeHtml(p.USER || p.RDB$USER || "-")}</td>
      <td><span class="badge">${escapeHtml(p.PRIVILEGE || p.RDB$PRIVILEGE || "-")}</span></td>
      <td>${p.GRANT_OPTION ? "Yes" : "No"}</td>
      <td>${escapeHtml(p.GRANTOR || p.RDB$GRANTOR || "-")}</td>
    </tr>
  `).join("");

  const indexRows = data.indexes.map(i => `
    <tr>
      <td><strong>${escapeHtml(i.NAME)}</strong></td>
      <td>${escapeHtml(i.TYPE)}</td>
      <td><code>${escapeHtml(i.FIELD)}</code></td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); margin: 0; padding: 16px; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 12px; margin-bottom: 16px; }
  .title { font-size: 1.2rem; font-weight: 600; margin: 0; }
  .tag { background: var(--vscode-badge-background, #007acc); color: var(--vscode-badge-foreground, #fff); padding: 3px 8px; border-radius: 4px; font-size: 0.8rem; text-transform: uppercase; }
  .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border, #333); gap: 4px; margin-bottom: 16px; }
  .tab-btn { background: transparent; border: none; color: var(--vscode-foreground, #ccc); padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.9rem; }
  .tab-btn.active { color: var(--vscode-panelTitle-activeForeground, #fff); border-bottom-color: var(--vscode-panelTitle-activeBorder, #007acc); font-weight: bold; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d); font-size: 0.88rem; }
  th { background: var(--vscode-panelSectionHeader-background, #252526); color: var(--vscode-panelTitle-activeForeground, #fff); }
  tr:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
  .badge { background: rgba(0,122,204,0.2); color: #569cd6; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.8rem; }
  pre { background: var(--vscode-textCodeBlock-background, #000); padding: 14px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .btn { background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 0.85rem; }
  .btn:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
</style>
</head>
<body>
  <div class="header">
    <h1 class="title">${escapeHtml(target.name)}</h1>
    <span class="tag">${target.type}</span>
  </div>

  <div class="tabs">
    <button class="tab-btn active" onclick="openTab('ddl')">📄 DDL Source</button>
    ${data.columns.length > 0 ? `<button class="tab-btn" onclick="openTab('columns')">📋 Columns (${data.columns.length})</button>` : ""}
    ${data.indexes.length > 0 ? `<button class="tab-btn" onclick="openTab('indexes')">🔑 Indexes & Constraints (${data.indexes.length})</button>` : ""}
    <button class="tab-btn" onclick="openTab('grants')">🔒 Grants (${data.privileges.length})</button>
  </div>

  <div id="ddl" class="tab-content active">
    <div style="display:flex; justify-content:flex-end; margin-bottom: 8px;">
      <button class="btn" onclick="copyDdl()">Copy DDL</button>
    </div>
    <pre id="ddlText">${escapeHtml(data.ddl)}</pre>
  </div>

  ${data.columns.length > 0 ? `
  <div id="columns" class="tab-content">
    <table>
      <thead>
        <tr>
          <th>Column</th>
          <th>Data Type</th>
          <th>Nullable</th>
          <th>Default</th>
          <th>Constraint</th>
        </tr>
      </thead>
      <tbody>
        ${columnsRows}
      </tbody>
    </table>
  </div>` : ""}

  ${data.indexes.length > 0 ? `
  <div id="indexes" class="tab-content">
    <table>
      <thead>
        <tr>
          <th>Index Name</th>
          <th>Type</th>
          <th>Field</th>
        </tr>
      </thead>
      <tbody>
        ${indexRows}
      </tbody>
    </table>
  </div>` : ""}

  <div id="grants" class="tab-content">
    ${data.privileges.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>User / Role</th>
          <th>Privilege</th>
          <th>With Grant Option</th>
          <th>Grantor</th>
        </tr>
      </thead>
      <tbody>
        ${privRows}
      </tbody>
    </table>` : "<p style='color: #888;'>No explicit grants recorded for this object.</p>"}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function openTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      event.currentTarget.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }
    function copyDdl() {
      const ddl = document.getElementById('ddlText').innerText;
      vscode.postMessage({ command: 'copyDdl', ddl: ddl });
    }
  </script>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

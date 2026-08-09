import {
  ExtensionContext, ViewColumn, WebviewPanel, window, env, commands
} from "vscode";
import * as cp from "node:child_process";
import { ConnectionOptions } from "../interfaces";
import { TaskTracker } from "../task-panel/task-tracker";
import { logger } from "../logger/logger";
import { getDatabaseFileName } from "../shared/utils";
import { renderGbakCommand } from "../shared/gbak-options";

export function showVisualBackupRestoreWizard(
  databaseNode?: any,
  context?: ExtensionContext,
  taskTracker?: TaskTracker
): void {
  const dbDetails: ConnectionOptions | undefined = databaseNode?.getDbDetails ? databaseNode.getDbDetails() : databaseNode?.dbDetails;
  
  const panel = window.createWebviewPanel(
    "firebirdBackupRestoreWizard",
    `Backup & Restore Wizard ${dbDetails ? `(${getDatabaseFileName(dbDetails.database)})` : ""}`,
    ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let activeChildProcess: cp.ChildProcess | undefined;

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.command) {
      case "pickBackupFile": {
        const uri = await window.showSaveDialog({
          title: "Select Backup Destination",
          filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
        });
        if (uri) {
          panel.webview.postMessage({ command: "setBackupPath", path: uri.fsPath });
        }
        break;
      }
      case "pickRestoreFile": {
        const uris = await window.showOpenDialog({
          title: "Select Firebird Backup File",
          filters: { "Firebird Backup": ["fbk"], "All files": ["*"] },
          canSelectMany: false,
        });
        if (uris && uris.length > 0) {
          panel.webview.postMessage({ command: "setRestorePath", path: uris[0].fsPath });
        }
        break;
      }
      case "startBackup": {
        const options = msg.options;
        const backupPath = options.backupPath;
        if (!backupPath) {
          window.showErrorMessage("Please select a target backup file path.");
          return;
        }

        const gbakExecutable = "gbak";
        const hostPort = dbDetails ? `${dbDetails.host}/${dbDetails.port || 3050}:${dbDetails.database}` : options.dbTarget;
        
        const args: string[] = ["-b"];
        if (options.transportable) args.push("-t");
        if (options.metadataOnly) args.push("-m");
        if (options.includeStats) args.push("-st");
        if (options.skipGarbageCollection) args.push("-g");
        if (options.ignoreChecksums) args.push("-ig");
        if (dbDetails) {
          args.push("-user", dbDetails.user, "-password", dbDetails.password || "");
        }
        args.push(hostPort, backupPath);

        panel.webview.postMessage({ command: "executionStarted", type: "Backup" });
        logger.info(`Wizard Backup starting: ${renderGbakCommand(gbakExecutable, args)}`);

        const task = taskTracker?.start(`Visual Backup: ${backupPath}`);
        activeChildProcess = cp.execFile(gbakExecutable, args);

        activeChildProcess.stderr?.on("data", (data) => {
          const text = String(data);
          logger.output(`[gbak] ${text}`);
          panel.webview.postMessage({ command: "appendOutput", text });
        });

        activeChildProcess.stdout?.on("data", (data) => {
          const text = String(data);
          logger.output(`[gbak] ${text}`);
          panel.webview.postMessage({ command: "appendOutput", text });
        });

        activeChildProcess.on("close", (code) => {
          activeChildProcess = undefined;
          if (code === 0) {
            panel.webview.postMessage({ command: "executionFinished", success: true, message: "Backup completed successfully!" });
            task?.complete();
            window.showInformationMessage(`Database backup completed: ${backupPath}`);
          } else {
            panel.webview.postMessage({ command: "executionFinished", success: false, message: `Backup failed with exit code ${code}.` });
            task?.fail(`Exit code ${code}`);
            window.showErrorMessage(`Backup failed with exit code ${code}.`);
          }
        });
        break;
      }
      case "startRestore": {
        const options = msg.options;
        const restorePath = options.restorePath;
        const targetDb = options.targetDb || (dbDetails ? `${dbDetails.host}/${dbDetails.port || 3050}:${dbDetails.database}` : "");
        
        if (!restorePath || !targetDb) {
          window.showErrorMessage("Please select both a backup source file and a target database.");
          return;
        }

        const gbakExecutable = "gbak";
        const args: string[] = [options.replaceExisting ? "-rep" : "-c"];
        if (options.deactivateTriggers) args.push("-inhibit_triggers");
        if (options.oneAtATime) args.push("-one_at_a_time");
        if (options.pageSize) args.push("-page_size", String(options.pageSize));
        if (dbDetails) {
          args.push("-user", dbDetails.user, "-password", dbDetails.password || "");
        }
        args.push(restorePath, targetDb);

        panel.webview.postMessage({ command: "executionStarted", type: "Restore" });
        logger.info(`Wizard Restore starting: ${renderGbakCommand(gbakExecutable, args)}`);

        const task = taskTracker?.start(`Visual Restore: ${restorePath} → ${targetDb}`);
        activeChildProcess = cp.execFile(gbakExecutable, args);

        activeChildProcess.stderr?.on("data", (data) => {
          const text = String(data);
          logger.output(`[gbak] ${text}`);
          panel.webview.postMessage({ command: "appendOutput", text });
        });

        activeChildProcess.stdout?.on("data", (data) => {
          const text = String(data);
          logger.output(`[gbak] ${text}`);
          panel.webview.postMessage({ command: "appendOutput", text });
        });

        activeChildProcess.on("close", (code) => {
          activeChildProcess = undefined;
          if (code === 0) {
            panel.webview.postMessage({ command: "executionFinished", success: true, message: "Restore completed successfully!" });
            task?.complete();
            window.showInformationMessage(`Database restore completed: ${targetDb}`);
          } else {
            panel.webview.postMessage({ command: "executionFinished", success: false, message: `Restore failed with exit code ${code}.` });
            task?.fail(`Exit code ${code}`);
            window.showErrorMessage(`Restore failed with exit code ${code}.`);
          }
        });
        break;
      }
      case "cancelExecution": {
        if (activeChildProcess) {
          activeChildProcess.kill();
          activeChildProcess = undefined;
          panel.webview.postMessage({ command: "executionFinished", success: false, message: "Execution cancelled by user." });
          window.showWarningMessage("Backup/Restore operation cancelled.");
        }
        break;
      }
    }
  });

  panel.webview.html = buildWizardHtml(dbDetails);
}

function buildWizardHtml(dbDetails?: ConnectionOptions): string {
  const dbName = dbDetails ? getDatabaseFileName(dbDetails.database) : "Firebird Database";
  const defaultTarget = dbDetails ? `${dbDetails.host}/${dbDetails.port || 3050}:${dbDetails.database}` : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); margin: 0; padding: 24px; max-width: 800px; }
  .title { font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 24px; }
  .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border, #333); margin-bottom: 20px; }
  .tab { padding: 10px 20px; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground, #ccc); font-size: 0.95rem; border-bottom: 2px solid transparent; }
  .tab.active { font-weight: bold; color: var(--vscode-panelTitle-activeForeground, #fff); border-bottom-color: var(--vscode-panelTitle-activeBorder, #007acc); }
  .section { display: none; }
  .section.active { display: block; }
  .form-group { margin-bottom: 18px; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
  input[type="text"], select { width: 100%; padding: 8px; background: var(--vscode-input-background, #252526); color: var(--vscode-input-foreground, #fff); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; box-sizing: border-box; }
  .file-picker-row { display: flex; gap: 8px; }
  .checkbox-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
  .checkbox-label { display: flex; align-items: center; gap: 8px; font-weight: normal; cursor: pointer; font-size: 0.85rem; }
  .btn { background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); border: none; padding: 9px 18px; border-radius: 4px; cursor: pointer; font-size: 0.9rem; font-weight: 600; }
  .btn:hover { background: var(--vscode-button-hoverBackground, #0062a3); }
  .btn-danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
  .output-box { background: #000; color: #00ff66; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 0.82rem; height: 180px; overflow-y: auto; white-space: pre-wrap; margin-top: 16px; border: 1px solid #333; }
  .status-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding: 10px; background: var(--vscode-panelSectionHeader-background, #252526); border-radius: 4px; }
</style>
</head>
<body>
  <div class="title">Visual Backup & Restore Wizard</div>
  <div class="subtitle">Execute logical <code>gbak</code> backups and restores with custom flags and live progress logs.</div>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('backup')">📦 Backup Database</button>
    <button class="tab" onclick="switchTab('restore')">🔄 Restore Database</button>
  </div>

  <!-- BACKUP TAB -->
  <div id="backup" class="section active">
    <div class="form-group">
      <label>Database Connection Target</label>
      <input type="text" id="backupDbTarget" value="${defaultTarget}" placeholder="host/3050:database.fdb">
    </div>

    <div class="form-group">
      <label>Destination Backup File (.fbk)</label>
      <div class="file-picker-row">
        <input type="text" id="backupPath" placeholder="/path/to/backup.fbk">
        <button class="btn" onclick="pickBackupFile()">Browse...</button>
      </div>
    </div>

    <div class="form-group">
      <label>Backup Options</label>
      <div class="checkbox-grid">
        <label class="checkbox-label"><input type="checkbox" id="chkTransportable" checked> 🚚 Transportable format (-t)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkMetadataOnly"> 📄 Metadata Only (-m)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkIncludeStats" checked> 📊 Include Statistics (-st)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkSkipGc"> 🧹 Skip Garbage Collection (-g)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkIgnoreChecksums"> ⚠️ Ignore Checksums (-ig)</label>
      </div>
    </div>

    <div style="margin-top: 20px;">
      <button class="btn" id="btnStartBackup" onclick="startBackup()">Start Backup</button>
    </div>
  </div>

  <!-- RESTORE TAB -->
  <div id="restore" class="section">
    <div class="form-group">
      <label>Source Backup File (.fbk)</label>
      <div class="file-picker-row">
        <input type="text" id="restorePath" placeholder="/path/to/backup.fbk">
        <button class="btn" onclick="pickRestoreFile()">Browse...</button>
      </div>
    </div>

    <div class="form-group">
      <label>Target Database Path / DSN</label>
      <input type="text" id="restoreTargetDb" value="${defaultTarget}" placeholder="host/3050:restored_database.fdb">
    </div>

    <div class="form-group">
      <label>Restore Options</label>
      <div class="checkbox-grid">
        <label class="checkbox-label"><input type="checkbox" id="chkReplaceExisting"> 🔄 Replace Existing (-rep)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkDeactivateTriggers"> 🚫 Deactivate Triggers (-inhibit_triggers)</label>
        <label class="checkbox-label"><input type="checkbox" id="chkOneAtATime"> 🔒 One Table at a Time (-one_at_a_time)</label>
      </div>
    </div>

    <div class="form-group">
      <label>Page Size</label>
      <select id="selPageSize">
        <option value="">Default (from backup)</option>
        <option value="4096">4096 bytes</option>
        <option value="8192">8192 bytes</option>
        <option value="16384" selected>16384 bytes (recommended)</option>
        <option value="32768">32768 bytes</option>
      </select>
    </div>

    <div style="margin-top: 20px;">
      <button class="btn" id="btnStartRestore" onclick="startRestore()">Start Restore</button>
    </div>
  </div>

  <!-- PROGRESS & OUTPUT LOG -->
  <div id="statusSection" style="display:none; margin-top: 24px;">
    <div class="status-bar">
      <span id="statusText">Operation running...</span>
      <button class="btn btn-danger" onclick="cancelExecution()">Cancel Operation</button>
    </div>
    <div class="output-box" id="outputLog"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function switchTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      event.currentTarget.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }

    function pickBackupFile() {
      vscode.postMessage({ command: 'pickBackupFile' });
    }

    function pickRestoreFile() {
      vscode.postMessage({ command: 'pickRestoreFile' });
    }

    function startBackup() {
      const options = {
        dbTarget: document.getElementById('backupDbTarget').value,
        backupPath: document.getElementById('backupPath').value,
        transportable: document.getElementById('chkTransportable').checked,
        metadataOnly: document.getElementById('chkMetadataOnly').checked,
        includeStats: document.getElementById('chkIncludeStats').checked,
        skipGarbageCollection: document.getElementById('chkSkipGc').checked,
        ignoreChecksums: document.getElementById('chkIgnoreChecksums').checked,
      };
      vscode.postMessage({ command: 'startBackup', options });
    }

    function startRestore() {
      const options = {
        restorePath: document.getElementById('restorePath').value,
        targetDb: document.getElementById('restoreTargetDb').value,
        replaceExisting: document.getElementById('chkReplaceExisting').checked,
        deactivateTriggers: document.getElementById('chkDeactivateTriggers').checked,
        oneAtATime: document.getElementById('chkOneAtATime').checked,
        pageSize: document.getElementById('selPageSize').value,
      };
      vscode.postMessage({ command: 'startRestore', options });
    }

    function cancelExecution() {
      vscode.postMessage({ command: 'cancelExecution' });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'setBackupPath') {
        document.getElementById('backupPath').value = msg.path;
      } else if (msg.command === 'setRestorePath') {
        document.getElementById('restorePath').value = msg.path;
      } else if (msg.command === 'executionStarted') {
        document.getElementById('statusSection').style.display = 'block';
        document.getElementById('outputLog').innerText = 'Starting ' + msg.type + ' operation...\n';
        document.getElementById('statusText').innerText = msg.type + ' running...';
      } else if (msg.command === 'appendOutput') {
        const log = document.getElementById('outputLog');
        log.innerText += msg.text;
        log.scrollTop = log.scrollHeight;
      } else if (msg.command === 'executionFinished') {
        document.getElementById('statusText').innerText = msg.message;
      }
    });
  </script>
</body>
</html>`;
}

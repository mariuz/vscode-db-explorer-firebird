import { window, ProgressLocation } from "vscode";
import { probeDocker } from "../shared/executable-probe";
import * as cp from "node:child_process";
import * as Firebird from "node-firebird";
import { getOptions } from "../config";
import { resolveDockerExecutable } from "../shared/docker-discovery";
import { FirebirdTreeDataProvider } from "../firebirdTreeDataProvider";
import { ConnectionOptions } from "../interfaces";
import { logger } from "../logger/logger";
import { TaskTracker } from "../task-panel/task-tracker";
import {
  ProvisionContainerOptions, dockerRunArgs, parseContainerId, resolveDatabasePath,
  suggestContainerName, FIREBIRD_IMAGE_TAGS,
} from "./docker-run";

const RUN_TIMEOUT_MS = 120000; // docker run may need to pull the image on first use
const READY_TIMEOUT_MS = 30000;
const READY_POLL_INTERVAL_MS = 1000;

const checkDockerExecutable = (candidate: string): Promise<boolean> => probeDocker(candidate);

function execDocker(dockerExe: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolve => {
    cp.execFile(dockerExe, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, error: error ?? undefined });
    });
  });
}

async function promptForOptions(): Promise<ProvisionContainerOptions | undefined> {
  const customLabel = "$(edit) Custom image...";
  const tagItems = [...FIREBIRD_IMAGE_TAGS.map(t => ({ label: t, description: `firebirdsql/firebird:${t}` })), { label: customLabel }];
  const tagPick = await window.showQuickPick(tagItems, { title: "Firebird Container: Image", placeHolder: "Select a Firebird version" });
  if (!tagPick) { return undefined; }

  let image = tagPick.label;
  if (image === customLabel) {
    const custom = await window.showInputBox({
      title: "Firebird Container: Custom Image",
      prompt: "Full Docker image reference",
      placeHolder: "e.g. firebirdsql/firebird:5.0",
    });
    if (!custom) { return undefined; }
    image = custom;
  }

  const containerName = await window.showInputBox({
    title: "Firebird Container: Name",
    value: suggestContainerName(),
    prompt: "Docker container name",
  });
  if (!containerName) { return undefined; }

  const portInput = await window.showInputBox({
    title: "Firebird Container: Host Port",
    value: "3050",
    prompt: "Host port to publish (the container always listens on 3050 internally)",
    validateInput: v => /^\d+$/.test(v) ? undefined : "Enter a port number",
  });
  if (!portInput) { return undefined; }

  const sysdbaPassword = await window.showInputBox({
    title: "Firebird Container: SYSDBA Password",
    value: "masterkey",
    password: true,
    prompt: "SYSDBA password for the new server",
  });
  if (!sysdbaPassword) { return undefined; }

  const databaseName = await window.showInputBox({
    title: "Firebird Container: Database",
    value: "test.fdb",
    prompt: "Database file to create (a bare filename, or an absolute path)",
  });
  if (!databaseName) { return undefined; }

  const persistPick = await window.showQuickPick(
    [
      { label: "Ephemeral", description: "Data is lost if the container is removed" },
      { label: "Persistent volume", description: "Stores data in a named Docker volume that survives container removal" },
    ],
    { title: "Firebird Container: Data Persistence" }
  );
  if (!persistPick) { return undefined; }
  const volumeName = persistPick.label === "Persistent volume" ? `${containerName}-data` : undefined;

  return { containerName, image, hostPort: Number(portInput), sysdbaPassword, databaseName, volumeName };
}

/** Polls by actually attaching (and immediately detaching) rather than a bare TCP check — the container's port can accept a TCP connection slightly before Firebird itself has finished initializing the database inside it. */
async function waitForFirebirdReady(options: Firebird.Options, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>(resolve => {
      Firebird.attach(options, (err, db) => {
        if (err) { resolve(false); return; }
        db.detach(() => resolve(true));
      });
    });
    if (ready) { return true; }
    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Provisions a brand-new local Firebird server as a Docker container (extends
 * shared/docker-discovery.ts's existing "detect containers already running" support with
 * "create one from scratch"), then adds it as a saved connection once it's confirmed to accept
 * connections.
 */
export async function runContainerProvisionWizard(
  firebirdTreeDataProvider: FirebirdTreeDataProvider,
  taskTracker?: TaskTracker
): Promise<void> {
  const dockerExe = await resolveDockerExecutable(getOptions().dockerPath || undefined, checkDockerExecutable);
  if (!dockerExe) {
    logger.showError("Docker executable not found. Install Docker, or set \"firebird.dockerPath\" to its full path.");
    return;
  }

  const options = await promptForOptions();
  if (!options) { return; }

  // Background Tasks entry (docs/roadmap/connection-management-enhancements.md, phase 4) —
  // alongside, not instead of, the withProgress notification below: a durable record for anyone
  // who dismisses or misses the toast before the container finishes coming up.
  const task = taskTracker?.start(`Creating Firebird container "${options.containerName}"`);

  await window.withProgress(
    { location: ProgressLocation.Notification, title: `Creating Firebird container "${options.containerName}"...`, cancellable: false },
    async progress => {
      const runResult = await execDocker(dockerExe, dockerRunArgs(options), RUN_TIMEOUT_MS);
      if (runResult.error) {
        const message = (runResult.stderr || runResult.error.message).trim();
        logger.error(`docker run failed: ${message}`);
        logger.showError(`Could not create the container: ${message}`);
        task?.fail(message);
        return;
      }
      const containerId = parseContainerId(runResult.stdout);
      logger.info(`Created Firebird container ${options.containerName} (${containerId.slice(0, 12)})`);

      progress.report({ message: "Waiting for Firebird to accept connections..." });
      const databasePath = resolveDatabasePath(options.databaseName);
      const ready = await waitForFirebirdReady(
        { host: "localhost", port: options.hostPort, database: databasePath, user: "sysdba", password: options.sysdbaPassword },
        READY_TIMEOUT_MS
      );

      const newConnection: ConnectionOptions = {
        id: "",
        host: "localhost",
        port: options.hostPort,
        database: databasePath,
        user: "sysdba",
        password: options.sysdbaPassword,
        role: null,
      };
      await firebirdTreeDataProvider.addKnownConnection(newConnection);

      if (ready) {
        logger.showInfo(`Firebird container "${options.containerName}" is up and connected.`);
        task?.complete();
      } else {
        logger.showInfo(
          `Firebird container "${options.containerName}" was created and added as a connection, but hasn't responded within ${READY_TIMEOUT_MS / 1000}s yet — it may still be starting up. Try the connection again shortly.`
        );
        task?.fail(`Container created but didn't respond within ${READY_TIMEOUT_MS / 1000}s — it may still be starting up.`);
      }
    }
  );
}

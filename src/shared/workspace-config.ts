import { workspace } from "vscode";
import { promises as fsp } from "fs";
import { isAbsolute, join } from "path";
import { ConnectionOptions, SshTunnelOptions } from "../interfaces";
import { logger } from "../logger/logger";

const CONFIG_RELATIVE_PATH = join(".vscode", "firebird.json");
const SSH_AUTH_METHODS = ["password", "privateKey", "agent"];

/**
 * Deterministic connection id for a workspace-declared connection, derived from its identifying
 * fields (not file position) so reordering entries in firebird.json doesn't orphan a password
 * already stored in SecretStorage under the old id. Prefixed so it can never collide with the
 * uuid-v1 ids FirebirdTreeDataProvider#addConnection() generates for globalState-saved connections.
 */
export function workspaceConnectionId(
  embedded: boolean,
  host: string | undefined,
  port: number | undefined,
  database: string,
  user: string | undefined
): string {
  const key = `${embedded ? "embedded" : (host ?? "")}:${port ?? ""}:${database}:${user ?? "SYSDBA"}`;
  return `workspace:${key}`;
}

/**
 * Parses one entry's optional "sshTunnel" field (docs/roadmap/ssh-tunneling.md) — structural,
 * non-secret config only (host/port/user/authMethod/privateKeyPath); the actual SSH password or
 * private-key passphrase can never live in the committed JSON, so it's deliberately not accepted
 * here at all — same rule as the top-level "password" field above, and resolved the same way at
 * connect time: via CredentialStore.getSshPassword(), keyed by this connection's deterministic
 * id (see workspaceConnectionId() above), set through the tree's "Set SSH Tunnel Password"
 * command once the connection appears. Any malformed piece of an sshTunnel object is a warning +
 * "ignore just the tunnel", not a reason to drop the whole connection entry — the same "one bad
 * field doesn't take down the whole entry" policy the rest of this function already follows.
 */
function parseWorkspaceSshTunnel(entry: any, label: string, embedded: boolean): SshTunnelOptions | undefined {
  const raw = entry.sshTunnel;
  if (raw === undefined) {
    return undefined;
  }
  if (embedded) {
    logger.warn(`${label} has an "sshTunnel" field but is "embedded" — ignored (an embedded/local-file database has no network host to tunnel to).`);
    return undefined;
  }
  if (!raw || typeof raw !== "object") {
    logger.warn(`${label} has an invalid "sshTunnel" field (expected an object) — ignored.`);
    return undefined;
  }
  if ("password" in raw || "passphrase" in raw) {
    logger.warn(`${label}'s "sshTunnel" has a "password"/"passphrase" field — ignored. SSH credentials must never be committed; use "Set SSH Tunnel Password" from the tree once the connection appears, and it's stored securely instead.`);
  }
  if (!raw.host || typeof raw.host !== "string") {
    logger.warn(`${label}'s "sshTunnel" is missing "host" — the tunnel config was ignored (the connection itself still loads without it).`);
    return undefined;
  }
  if (typeof raw.port !== "number") {
    logger.warn(`${label}'s "sshTunnel" is missing a numeric "port" — the tunnel config was ignored (the connection itself still loads without it).`);
    return undefined;
  }
  if (!raw.user || typeof raw.user !== "string") {
    logger.warn(`${label}'s "sshTunnel" is missing "user" — the tunnel config was ignored (the connection itself still loads without it).`);
    return undefined;
  }
  if (!SSH_AUTH_METHODS.includes(raw.authMethod)) {
    logger.warn(`${label}'s "sshTunnel" has an invalid "authMethod" (expected "password", "privateKey", or "agent") — the tunnel config was ignored (the connection itself still loads without it).`);
    return undefined;
  }
  if (raw.authMethod === "privateKey" && (!raw.privateKeyPath || typeof raw.privateKeyPath !== "string")) {
    logger.warn(`${label}'s "sshTunnel" has authMethod "privateKey" but no "privateKeyPath" — the tunnel config was ignored (the connection itself still loads without it).`);
    return undefined;
  }

  const tunnel: SshTunnelOptions = { host: raw.host, port: raw.port, user: raw.user, authMethod: raw.authMethod };
  if (raw.authMethod === "privateKey") {
    tunnel.privateKeyPath = raw.privateKeyPath;
  }
  return tunnel;
}

/**
 * Parses one workspace firebird.json's contents into ConnectionOptions. Pure (no fs/vscode
 * access) so it's directly unit-testable — the impure file-reading lives in
 * loadWorkspaceConnections() below. Throws on structurally invalid JSON (e.g. not an object, no
 * "connections" array); individual malformed entries are skipped with a logged warning instead,
 * so one bad entry doesn't take down every other connection in the file.
 */
export function parseWorkspaceConfig(jsonText: string, folderPath: string, folderLabel: string): ConnectionOptions[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`invalid JSON: ${(err as Error).message}`);
  }

  const connections = (raw as { connections?: unknown })?.connections;
  if (!Array.isArray(connections)) {
    throw new Error('expected a top-level "connections" array');
  }

  const results: ConnectionOptions[] = [];
  connections.forEach((entry: any, index: number) => {
    const label = `${folderLabel}/${CONFIG_RELATIVE_PATH}: entry ${index}${entry?.name ? ` ("${entry.name}")` : ""}`;

    if (!entry || typeof entry !== "object") {
      logger.warn(`${label} is not an object — skipped.`);
      return;
    }
    if ("password" in entry) {
      logger.warn(`${label} has a "password" field — ignored. Passwords must never be committed; use "Set Connection Password" from the tree once it appears, and it's stored securely instead.`);
    }
    if (!entry.database || typeof entry.database !== "string") {
      logger.warn(`${label} is missing "database" — skipped.`);
      return;
    }
    const embedded = Boolean(entry.embedded);
    if (!embedded && (!entry.host || typeof entry.host !== "string")) {
      logger.warn(`${label} is missing "host" and isn't marked "embedded" — skipped.`);
      return;
    }

    const database = isAbsolute(entry.database) ? entry.database : join(folderPath, entry.database);
    const host = embedded ? "" : entry.host;
    const port = embedded ? null : (typeof entry.port === "number" ? entry.port : 3050);
    const user = typeof entry.user === "string" && entry.user ? entry.user : "SYSDBA";
    const wireCrypt = ["Required", "Enabled", "Disabled"].includes(entry.wireCrypt) ? entry.wireCrypt : undefined;
    const sshTunnel = parseWorkspaceSshTunnel(entry, label, embedded);

    results.push({
      id: workspaceConnectionId(embedded, host, port, database, user),
      host,
      port,
      database,
      user,
      role: typeof entry.role === "string" ? entry.role : null,
      embedded,
      wireCrypt,
      authPlugin: typeof entry.authPlugin === "string" ? entry.authPlugin : undefined,
      workspace: true,
      isDefault: Boolean(entry.default),
      sshTunnel,
    });
  });

  return results;
}

/**
 * Reads every open workspace folder's .vscode/firebird.json (if any) and returns the connections
 * it declares. A missing file is normal (most folders won't have one) and silently yields none;
 * a present-but-invalid file is reported once via the log/notification and otherwise skipped, so
 * a typo can't break the tree or block activation.
 */
export async function loadWorkspaceConnections(): Promise<ConnectionOptions[]> {
  // Never in an untrusted folder. The file cannot carry a password by design, which means a
  // malicious repository's entry would instead *prompt* for one — a connection called "Staging DB"
  // pointing at a server the attacker controls, with the user typing their real credentials into
  // it. That is the whole reason this extension declares `untrustedWorkspaces: "limited"` rather
  // than full support; see capabilities.untrustedWorkspaces in package.json.
  if (workspace.isTrusted === false) {
    logger.info("Workspace connections from .vscode/firebird.json are ignored until you trust this folder.");
    return [];
  }

  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const all: ConnectionOptions[] = [];
  for (const folder of folders) {
    const filePath = join(folder.uri.fsPath, CONFIG_RELATIVE_PATH);
    let text: string;
    try {
      text = await fsp.readFile(filePath, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        logger.error(`Failed to read ${filePath}: ${err?.message ?? err}`);
      }
      continue;
    }
    try {
      all.push(...parseWorkspaceConfig(text, folder.uri.fsPath, folder.name));
    } catch (err: any) {
      logger.showError(`Invalid ${filePath}: ${err?.message ?? err}`);
    }
  }
  return all;
}

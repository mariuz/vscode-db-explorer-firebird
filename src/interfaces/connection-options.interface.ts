import { ConnectionColor } from "../shared/connection-color";

/**
 * Firebird connection options
 *
 * https://www.npmjs.com/package/node-firebird
 */
export interface ConnectionOptions {
  id: string;
  host: string;
  port: any;
  database: string;
  user: string;
  /** Password is stored in SecretStorage and populated at runtime; not persisted in globalState. */
  password?: string;
  role: string | null;
  /** When true, connects to an embedded (local file) Firebird database — no host/port required. */
  embedded?: boolean;
  /** Wire encryption mode for Firebird 4.x/5.x (WireCrypt). */
  wireCrypt?: 'Required' | 'Enabled' | 'Disabled';
  /** Authentication plugin for Firebird 4.x/5.x (e.g. Srp256, Srp, Legacy_Auth). */
  authPlugin?: string;
  /**
   * Firebird 6+ only: the schema unqualified names in this connection resolve through, applied when
   * the session opens rather than by a statement in a document.
   *
   * Firebird has no "default schema" attachment parameter — `CURRENT_SCHEMA` is simply the first
   * existing entry of the search path — so this is sent as the front of `isc_dpb_search_path`, with
   * `PUBLIC` kept behind it as a fallback and `SYSTEM` appended by the server. Ignored by servers
   * older than 6, which negotiate a protocol that has no such parameter.
   */
  defaultSchema?: string;
  /** True for connections sourced from a workspace's .vscode/firebird.json rather than globalState — never persisted there, and re-derived from disk on every tree refresh. */
  workspace?: boolean;
  /** Whether this workspace connection was marked "default": true — see workspace-config.ts. */
  isDefault?: boolean;
  /** Optional folder/group name — when set, groups this connection under that name in the tree instead of by host. */
  group?: string;
  /** Optional color tag for quick visual identification in the tree icon and status bar. */
  color?: ConnectionColor;
  /** Lowercase column names in query results (node-firebird option). */
  lowercase_keys?: boolean;
  /** Explicit opt-in: exposes this connection's schema (never its password) to the firebird.mcp MCP server, if enabled. Defaults to false/unset — an MCP client sees nothing unless a connection opts in. */
  mcpExposed?: boolean;
  /** Explicit, separate opt-in on top of mcpExposed: lets the MCP server's run_write_query tool run a single INSERT/UPDATE/DELETE against this connection, not just read it. Defaults to false/unset. Toggling mcpExposed off also clears this — see NodeDatabase.toggleMcpExposure(), so re-enabling exposure later never silently reactivates write access without its own confirmation. */
  mcpWriteEnabled?: boolean;
  /** Reach host/port through an SSH tunnel (bastion/jump host) rather than connecting directly — see src/shared/ssh-tunnel.ts. The SSH password/passphrase itself is never stored here; it's kept in SecretStorage via CredentialStore, the same way the database password is. */
  sshTunnel?: SshTunnelOptions;
  /** SSH password (authMethod "password") or private key passphrase (authMethod "privateKey"), collected by the connection wizard. Like `password`, this is stored in SecretStorage (CredentialStore.storeSshPassword()) and stripped before persisting to globalState — never present outside the wizard-to-save round trip. */
  sshTunnelPassword?: string;
}

export interface SshTunnelOptions {
  host: string;
  port: number;
  user: string;
  authMethod: "password" | "privateKey" | "agent";
  /** Only for authMethod "privateKey" — path to an OpenSSH-format private key file. */
  privateKeyPath?: string;
}

/**
 * Parses a pasted Firebird connection string to prefill the "Add New Connection" wizard, instead
 * of stepping through every field by hand. Pure — no vscode dependency — unit-testable the same
 * way docker-discovery.ts is; the wizard integration lives in connection-wizard.ts.
 *
 * Supported form: `firebird://[user[:password]@]host[:port]/database[?role=...&wireCrypt=...]`.
 * There's no single canonical Firebird connection-string format the way JDBC/ODBC tools have one
 * — this URL shape was chosen because it's unambiguous to parse with the standard `URL` class and
 * matches the convention users already expect from postgres://, mysql://, etc. Firebird's own bare
 * `host/port:database` DSN syntax is deliberately NOT supported here: it's genuinely ambiguous
 * against a Windows absolute path like `C:\data\test.fdb`, and silently mis-parsing a pasted
 * connection string is worse than requiring the one supported format.
 */

import { ConnectionOptions } from "../interfaces";

const VALID_WIRE_CRYPT = new Set(["Required", "Enabled", "Disabled"]);

/**
 * A URL pathname always has one leading "/" (the path-start delimiter). This scheme's convention
 * for an absolute database path is a doubled slash (mirroring sqlite:////absolute/path.db) —
 * stripping exactly one leading character turns "//var/lib/x.fdb" into "/var/lib/x.fdb" (absolute,
 * correct) and "/employee" into "employee" (a bare alias, also correct) uniformly. If the caller
 * only typed a single slash before an otherwise-absolute-looking path (still containing further
 * "/"s after stripping), restore the leading slash rather than silently handing Firebird a
 * relative path the user didn't intend.
 */
function normalizeDatabasePath(pathname: string): string {
  const stripped = pathname.slice(1);
  if (pathname.startsWith("//")) {
    return stripped;
  }
  return stripped.includes("/") ? `/${stripped}` : stripped;
}

/** Returns the parsed fields, or undefined if `input` isn't a recognizable Firebird connection string. */
export function parseConnectionString(input: string): Partial<ConnectionOptions> | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "firebird:" || !url.hostname) {
    return undefined;
  }

  const database = normalizeDatabasePath(url.pathname);
  if (!database) {
    return undefined;
  }

  const result: Partial<ConnectionOptions> = {
    host: url.hostname,
    database,
    embedded: false,
  };
  if (url.port) {
    result.port = Number(url.port);
  }
  if (url.username) {
    result.user = decodeURIComponent(url.username);
  }
  if (url.password) {
    result.password = decodeURIComponent(url.password);
  }
  const role = url.searchParams.get("role");
  if (role) {
    result.role = role;
  }
  const wireCrypt = url.searchParams.get("wireCrypt");
  if (wireCrypt && VALID_WIRE_CRYPT.has(wireCrypt)) {
    result.wireCrypt = wireCrypt as ConnectionOptions["wireCrypt"];
  }
  return result;
}

export type ConnectionStringFormat = 'url' | 'native' | 'jdbc' | 'node';

export function buildFirebirdUrlString(options: ConnectionOptions): string {
  if (options.embedded) {
    const db = options.database.startsWith('/') ? options.database : `/${options.database}`;
    return `firebird://${db}`;
  }
  const userPart = options.user ? `${encodeURIComponent(options.user)}@` : '';
  const portPart = options.port ? `:${options.port}` : '';
  const roleParam = options.role ? `?role=${encodeURIComponent(options.role)}` : '';
  return `firebird://${userPart}${options.host}${portPart}/${options.database}${roleParam}`;
}

export function buildJdbcUrlString(options: ConnectionOptions): string {
  if (options.embedded) {
    return `jdbc:firebirdsql:embedded:${options.database}`;
  }
  const portPart = options.port ? `:${options.port}` : '';
  const params: string[] = [];
  if (options.user) { params.push(`user=${encodeURIComponent(options.user)}`); }
  if (options.role) { params.push(`roleName=${encodeURIComponent(options.role)}`); }
  const queryStr = params.length > 0 ? `?${params.join('&')}` : '';
  return `jdbc:firebirdsql://${options.host}${portPart}/${options.database}${queryStr}`;
}

export function buildNodeFirebirdConfigString(options: ConnectionOptions): string {
  const configObj: Record<string, any> = {
    host: options.host || 'localhost',
    port: options.port || 3050,
    database: options.database,
    user: options.user || 'SYSDBA',
    password: '<password>',
  };
  if (options.role) {
    configObj.role = options.role;
  }
  if (options.lowercase_keys) {
    configObj.lowercase_keys = true;
  }
  return JSON.stringify(configObj, null, 2);
}

/**
 * "Copy Connection String" (docs/roadmap/connection-management-enhancements.md, phase 2).
 * Supports Firebird URL (`firebird://`), native DSN (`host/port:database`), JDBC URL (`jdbc:firebirdsql://`),
 * or node-firebird config object.
 */
export function buildConnectionString(options: ConnectionOptions, format: ConnectionStringFormat = 'native'): string {
  switch (format) {
    case 'url':
      return buildFirebirdUrlString(options);
    case 'jdbc':
      return buildJdbcUrlString(options);
    case 'node':
      return buildNodeFirebirdConfigString(options);
    case 'native':
    default: {
      const dsn = options.embedded
        ? options.database
        : `${options.host}${options.port ? `/${options.port}` : ""}:${options.database}`;
      const userLine = options.user ? `\n-- User: ${options.user}` : "";
      return `${dsn}${userLine}\n-- Password not included; set it separately.`;
    }
  }
}

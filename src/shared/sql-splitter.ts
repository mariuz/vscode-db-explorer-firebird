/**
 * Splits a SQL document into individual statements.
 *
 * Handles:
 *  - single-quoted string literals (including escaped quotes '')
 *  - line comments (--)
 *  - block comments (slash-star ... star-slash)
 *  - semicolon statement terminator
 *
 * Empty / whitespace-only statements are filtered out.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        current += sql.slice(i);
        break;
      }
      current += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) {
        current += sql.slice(i);
        break;
      }
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Single-quoted string (including '' escaped quotes)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    // Statement terminator
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const remaining = current.trim();
  if (remaining) {
    statements.push(remaining);
  }

  return statements;
}

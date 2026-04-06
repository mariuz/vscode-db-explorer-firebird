/**
 * Simple SQL formatter for Firebird SQL.
 * Uppercases keywords and places major clauses on new lines with indentation.
 */

/** SQL keywords that should start a new line (top-level clauses) */
const NEWLINE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'HAVING',
  'INNER JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'ON', 'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', 'CREATE TRIGGER',
  'ALTER TABLE', 'DROP TABLE',
];

/** All SQL keywords that should be uppercased */
const ALL_KEYWORDS = [
  ...NEWLINE_KEYWORDS,
  'AS', 'IN', 'NOT IN', 'NOT', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'EXISTS', 'DISTINCT', 'ALL', 'ANY', 'SOME',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXECUTE', 'PROCEDURE',
  'FIRST', 'SKIP', 'ROWS', 'TO', 'WITH', 'INTO', 'OF',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'NOT NULL', 'DEFAULT',
  'COALESCE', 'NULLIF', 'CAST', 'EXTRACT', 'TRIM', 'SUBSTRING', 'UPPER', 'LOWER',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER',
  'TABLE', 'VIEW', 'TRIGGER', 'GENERATOR', 'SEQUENCE', 'INDEX',
  'ASCENDING', 'DESCENDING', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
];

/** Sort longer phrases first to avoid partial matches (e.g. "LEFT OUTER JOIN" before "LEFT JOIN") */
const SORTED_KEYWORDS = [...new Set([...ALL_KEYWORDS])].sort((a, b) => b.length - a.length);

/**
 * Formats a SQL string:
 * - Uppercases SQL keywords
 * - Places major clauses on new lines
 * - Indents column lists after SELECT
 */
export function formatSQL(sql: string): string {
  if (!sql || !sql.trim()) {
    return sql;
  }

  // Preserve string literals and comments so we don't modify them
  const placeholders: string[] = [];
  let processed = sql;

  // Replace single-quoted string literals with placeholders
  processed = processed.replace(/'(?:[^'\\]|\\.)*'/g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00STR${idx}\x00`;
  });

  // Replace line comments (-- ...) with placeholders
  processed = processed.replace(/--[^\n]*/g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00CMT${idx}\x00`;
  });

  // Replace block comments (/* ... */) with placeholders
  processed = processed.replace(/\/\*[\s\S]*?\*\//g, match => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00BLK${idx}\x00`;
  });

  // Uppercase all SQL keywords (case-insensitive match)
  for (const kw of SORTED_KEYWORDS) {
    const pattern = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    processed = processed.replace(pattern, kw);
  }

  // Insert newlines before major clauses
  for (const kw of NEWLINE_KEYWORDS) {
    const pattern = new RegExp(`(?<![\\x00])(\\s*)\\b(${kw.replace(/\s+/g, '\\s+')})\\b`, 'gi');
    processed = processed.replace(pattern, (_match, _space, keyword) => `\n${keyword.toUpperCase()}`);
  }

  // Indent SELECT column list: columns separated by commas on their own lines
  processed = processed.replace(/\bSELECT\b([\s\S]*?)\bFROM\b/gi, (_match, cols) => {
    const trimmed = cols.trim();
    if (!trimmed || trimmed === '*') {
      return `SELECT ${trimmed}\nFROM`;
    }
    const columns = trimmed.split(',').map((c: string) => `    ${c.trim()}`).join(',\n');
    return `SELECT\n${columns}\nFROM`;
  });

  // Clean up excessive blank lines and normalize line endings
  processed = processed
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Restore placeholders
  processed = processed.replace(/\x00(STR|CMT|BLK)(\d+)\x00/g, (_m, _type, idx) => placeholders[Number(idx)]);

  return processed;
}

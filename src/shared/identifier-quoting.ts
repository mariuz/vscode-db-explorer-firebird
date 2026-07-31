import { firebirdReserved } from "../language-server/firebird-reserved";

/**
 * Drag Object Explorer Entity into Editor (docs/roadmap/drag-identifier-into-editor.md), phase 2
 * — Firebird's own identifier-quoting rules: an unquoted identifier is folded to uppercase and may
 * only contain `[A-Z0-9_$]`, starting with a letter. A real object name that already matches that
 * shape *and* isn't a reserved word can be referenced unquoted exactly as stored; anything else
 * (mixed/lower case, other characters, a name colliding with a reserved word) needs `"..."`
 * double-quoting to be referenced correctly, with any literal `"` in the name doubled per standard
 * SQL identifier-quoting escaping (mirrors how sql-splitter.ts handles `''` inside string
 * literals). Deliberately a separate function from sanitizeIdentifier() (flat-file-parser.ts):
 * that one *mutates* an arbitrary CSV header into a new valid identifier (replacing bad characters
 * with `_`); this one must preserve a real, already-existing object name exactly and only decide
 * whether it needs quoting to be referenced correctly.
 */
const UNQUOTED_IDENTIFIER = /^[A-Z][A-Z0-9_$]*$/;

/**
 * Firebird's reserved words (langref appendix "Reserved Words and Keywords", through Firebird 5),
 * as the authority for "does this name need quoting". firebird-reserved.ts is *not* that authority
 * on its own: it's a completion list, so it mixes in non-reserved keywords and multi-word snippets
 * ("EXECUTE BLOCK") while missing real reserved words that never needed a completion entry --
 * OFFSET, ROW, BOOLEAN, OVER and WINDOW among them. Missing a word here is the harmful direction
 * (a column genuinely named ROW would be inserted unquoted and fail to parse); an extra word is
 * harmless, since quoting a name that was created unquoted -- and so is stored uppercase -- refers
 * to exactly the same object. The two sets are therefore unioned rather than swapped.
 */
const FIREBIRD_RESERVED_WORDS = [
  "ADD", "ADMIN", "ALL", "ALTER", "AND", "ANY", "AS", "AT", "AVG", "BEGIN", "BETWEEN", "BIGINT",
  "BINARY", "BIT_LENGTH", "BLOB", "BOOLEAN", "BOTH", "BY", "CASE", "CAST", "CHAR", "CHAR_LENGTH",
  "CHARACTER", "CHARACTER_LENGTH", "CHECK", "CLOSE", "COLLATE", "COLUMN", "COMMENT", "COMMIT",
  "CONNECT", "CONSTRAINT", "CORR", "COUNT", "COVAR_POP", "COVAR_SAMP", "CREATE", "CROSS",
  "CURRENT", "CURRENT_CONNECTION", "CURRENT_DATE", "CURRENT_ROLE", "CURRENT_TIME",
  "CURRENT_TIMESTAMP", "CURRENT_TRANSACTION", "CURRENT_USER", "CURSOR", "DATE", "DAY", "DEC",
  "DECFLOAT", "DECIMAL", "DECLARE", "DEFAULT", "DELETE", "DELETING", "DETERMINISTIC", "DISCONNECT",
  "DISTINCT", "DOUBLE", "DROP", "ELSE", "END", "ESCAPE", "EXECUTE", "EXISTS", "EXTERNAL", "EXTRACT",
  "FALSE", "FETCH", "FILTER", "FLOAT", "FOR", "FOREIGN", "FROM", "FULL", "FUNCTION", "GDSCODE",
  "GLOBAL", "GRANT", "GROUP", "HAVING", "HOUR", "IF", "IN", "INDEX", "INNER", "INSENSITIVE",
  "INSERT", "INSERTING", "INT", "INT128", "INTEGER", "INTO", "IS", "JOIN", "LATERAL", "LEADING",
  "LEFT", "LIKE", "LOCAL", "LOCALTIME", "LOCALTIMESTAMP", "LONG", "LOWER", "MAX", "MERGE", "MIN",
  "MINUTE", "MONTH", "NATIONAL", "NATURAL", "NCHAR", "NO", "NOT", "NULL", "NUMERIC", "OCTET_LENGTH",
  "OF", "OFFSET", "ON", "ONLY", "OPEN", "OR", "ORDER", "OUTER", "OVER", "PARAMETER", "PLAN",
  "POSITION", "POST_EVENT", "PRECISION", "PRIMARY", "PROCEDURE", "PUBLICATION", "RDB$DB_KEY",
  "RDB$ERROR", "RDB$GET_CONTEXT", "RDB$GET_TRANSACTION_CN", "RDB$RECORD_VERSION", "RDB$ROLE_IN_USE",
  "RDB$SET_CONTEXT", "RDB$SYSTEM_PRIVILEGE", "REAL", "RECORD_VERSION", "RECREATE", "RECURSIVE",
  "REFERENCES", "REGR_AVGX", "REGR_AVGY", "REGR_COUNT", "REGR_INTERCEPT", "REGR_R2", "REGR_SLOPE",
  "REGR_SXX", "REGR_SXY", "REGR_SYY", "RELEASE", "RESETTING", "RETURN", "RETURNING_VALUES",
  "RETURNS", "REVOKE", "RIGHT", "ROLLBACK", "ROW", "ROW_COUNT", "ROWS", "SAVEPOINT", "SCROLL",
  "SECOND", "SELECT", "SENSITIVE", "SET", "SIMILAR", "SMALLINT", "SOME", "SQLCODE", "SQLSTATE",
  "START", "STDDEV_POP", "STDDEV_SAMP", "SUM", "TABLE", "THEN", "TIME", "TIMESTAMP", "TIMEZONE_HOUR",
  "TIMEZONE_MINUTE", "TO", "TRAILING", "TRIGGER", "TRIM", "TRUE", "UNBOUNDED", "UNION", "UNIQUE",
  "UNKNOWN", "UPDATE", "UPDATING", "UPPER", "USER", "USING", "VALUE", "VALUES", "VAR_POP",
  "VAR_SAMP", "VARBINARY", "VARCHAR", "VARIABLE", "VARYING", "VIEW", "WHEN", "WHERE", "WHILE",
  "WINDOW", "WITH", "WITHOUT", "YEAR",
];

const RESERVED_WORDS = new Set([
  ...FIREBIRD_RESERVED_WORDS,
  ...firebirdReserved.map(w => w.label.toUpperCase()),
]);

export function quoteIdentifierIfNeeded(name: string): string {
  if (UNQUOTED_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

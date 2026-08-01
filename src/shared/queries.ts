import { assertValidIdentifier } from "./row-edit";

export function getTablesQuery(maxTableCount: number): string {
  if (maxTableCount !== 0) {
    return `SELECT FIRST ${Math.abs(maxTableCount)} RDB$RELATION_NAME TABLE_NAME
              FROM RDB$RELATIONS
             WHERE RDB$VIEW_BLR IS NULL
               AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
          ORDER BY 1;`;
  } else {
    return `SELECT RDB$RELATION_NAME TABLE_NAME
              FROM RDB$RELATIONS
             WHERE RDB$VIEW_BLR IS NULL
               AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
          ORDER BY 1;`;
  }
}

/**
 * FIELD_LENGTH here (and at every other `RDB$FIELD_LENGTH AS FIELD_LENGTH` site in this file —
 * fieldsQuery(), viewColumnsQuery(), procedureParametersQuery()/getAllProcedureParametersQuery(),
 * getDomainsQuery(), getSchemaColumnsQuery()) is `COALESCE(RDB$CHARACTER_LENGTH, RDB$FIELD_LENGTH)`,
 * not bare RDB$FIELD_LENGTH: confirmed directly against a live Firebird 6.0 server that
 * RDB$FIELD_LENGTH is the column's storage size in **bytes**, not characters — for a UTF8-charset
 * VARCHAR(150), RDB$FIELD_LENGTH reports 600 (150 × 4 bytes/char), while RDB$CHARACTER_LENGTH
 * correctly reports 150. Every caller that builds a `VARCHAR(n)`/`CHAR(n)` DDL fragment from this
 * value (columnTypeToDDL() in database-projects/project-model.ts chief among them) was reading the
 * byte count as if it were the character count — a real, pre-existing bug for any UTF8-charset
 * database (the modern recommended default), caught by Database Projects' Publish round-trip
 * actually re-diffing a database it had just rebuilt from its own Extract output and finding a
 * spurious "changed" column/domain purely from this 4×-inflated length. RDB$CHARACTER_LENGTH is
 * only ever non-null for CHAR(14)/VARCHAR(37) (confirmed live across INTEGER/BIGINT/BLOB/NUMERIC/
 * TIMESTAMP/BOOLEAN too) — exactly the two RDB$FIELD_TYPE values every consumer of FIELD_LENGTH
 * actually uses it for — so the COALESCE fallback to the old RDB$FIELD_LENGTH value for every other
 * type changes nothing for them.
 */
export function tableInfoQuery(tableName: string): string {
  return `SELECT TRIM(r.RDB$FIELD_NAME) AS FIELD_NAME,
         CASE f.RDB$FIELD_TYPE
           WHEN 261 THEN 'BLOB'
           WHEN 14  THEN 'CHAR'
           WHEN 40  THEN 'CSTRING'
           WHEN 11  THEN 'D_FLOAT'
           WHEN 27  THEN 'DOUBLE'
           WHEN 10  THEN 'FLOAT'
           WHEN 16  THEN 'INT64'
           WHEN 8   THEN 'INTEGER'
           WHEN 9   THEN 'QUAD'
           WHEN 7   THEN 'SMALLINT'
           WHEN 12  THEN 'DATE'
           WHEN 13  THEN 'TIME'
           WHEN 35  THEN 'TIMESTAMP'
           WHEN 37  THEN 'VARCHAR'
           WHEN 23  THEN 'BOOLEAN'
           ELSE 'UNKNOWN'
         END AS FIELD_TYPE,
            COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS FIELD_LENGTH,
            f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
            f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
            f.RDB$FIELD_SCALE AS FIELD_SCALE,
            MIN(rc.RDB$CONSTRAINT_TYPE) AS CONSTRAINT_TYPE,
            MIN(i.RDB$INDEX_NAME) AS INDEX_NAME,
            CASE WHEN r.RDB$NULL_FLAG = 1 THEN 1 ELSE 0 END AS NOT_NULL,
            cast(r.RDB$DEFAULT_SOURCE as varchar(100) character set utf8) AS DFLT_VALUE,
            r.RDB$FIELD_POSITION AS FIELD_POSITION
       FROM RDB$RELATION_FIELDS r
  LEFT JOIN RDB$FIELDS f ON r.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
  LEFT JOIN RDB$INDEX_SEGMENTS s ON s.RDB$FIELD_NAME=r.RDB$FIELD_NAME
  LEFT JOIN RDB$INDICES i ON i.RDB$INDEX_NAME = s.RDB$INDEX_NAME
        AND i.RDB$RELATION_NAME=r.RDB$RELATION_NAME
  LEFT JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$INDEX_NAME = s.RDB$INDEX_NAME
        AND rc.RDB$INDEX_NAME = i.RDB$INDEX_NAME
        AND rc.RDB$RELATION_NAME = i.RDB$RELATION_NAME
  LEFT JOIN RDB$REF_CONSTRAINTS refc ON rc.RDB$CONSTRAINT_NAME = refc.RDB$CONSTRAINT_NAME
      WHERE (r.rdb$system_flag is null or r.rdb$system_flag = 0) AND r.RDB$RELATION_NAME ='${tableName}'
   GROUP BY FIELD_NAME, FIELD_TYPE, FIELD_LENGTH, FIELD_SUB_TYPE, FIELD_PRECISION, FIELD_SCALE, NOT_NULL, DFLT_VALUE, FIELD_POSITION
   ORDER BY FIELD_POSITION;`;
}

export function fieldsQuery(tables: string[]): string {
  const string = tables.join("','");
  return `SELECT TRIM(r.RDB$FIELD_NAME) AS Field,
       TRIM(r.RDB$RELATION_NAME) AS Tbl,
  CASE WHEN r.RDB$NULL_FLAG = 1 THEN '1' ELSE '0' END AS NOTNULL,
            r.RDB$DEFAULT_VALUE AS DFLT_VALUE,
            r.RDB$FIELD_POSITION AS Pos,
            CASE f.RDB$FIELD_TYPE
              WHEN 261 THEN 'BLOB'
              WHEN 14  THEN 'CHAR'
              WHEN 40  THEN 'CSTRING'
              WHEN 11  THEN 'D_FLOAT'
              WHEN 27  THEN 'DOUBLE'
              WHEN 10  THEN 'FLOAT'
              WHEN 16  THEN 'INT64'
              WHEN 8   THEN 'INTEGER'
              WHEN 9   THEN 'QUAD'
              WHEN 7   THEN 'SMALLINT'
              WHEN 12  THEN 'DATE'
              WHEN 13  THEN 'TIME'
              WHEN 35  THEN 'TIMESTAMP'
              WHEN 37  THEN 'VARCHAR'
              ELSE 'UNKNOWN'
            END AS FIELD_TYPE,
            COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) as FIELD_LENGTH
       FROM RDB$RELATION_FIELDS r
      left join RDB$FIELDS f on f.RDB$FIELD_NAME = r.RDB$FIELD_SOURCE
      WHERE (r.rdb$system_flag IS NULL OR r.rdb$system_flag = 0) 
        AND r.RDB$RELATION_NAME IN ('${string}')
   GROUP BY Field, Tbl, NOTNULL, DFLT_VALUE, Pos, FIELD_TYPE, FIELD_LENGTH
   ORDER BY Tbl, Pos;`;
}

/**
 * "Select All Records" for a table or view.
 *
 * `maxRows` becomes a Firebird `FIRST n` clause — a genuine *server-side* cap, so the rows never
 * leave the server rather than being fetched and then discarded. That distinction matters: the
 * pure-JS driver hands back a whole result set in one callback with no streaming loop to stop, so
 * for arbitrary user SQL the only available limit is on what reaches the webview. Here, where the
 * extension writes the query itself, the limit can be real.
 *
 * 0 (or anything not a positive integer) means no limit, matching `firebird.maxTablesCount`'s
 * existing convention.
 */
export function selectAllRecordsQuery(tableName: string, maxRows = 0): string {
  const first = Number.isInteger(maxRows) && maxRows > 0 ? `FIRST ${maxRows} ` : "";
  return `SELECT ${first}* FROM ${tableName};`;
}

export function dropTableQuery(tableName: string): string {
  return `DROP TABLE ${tableName};`;
}

export const databaseInfoQry: string = `
  SELECT RDB$GET_CONTEXT('SYSTEM', 'DB_NAME'         ) AS DB_NAME,
         RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION'  ) AS ENGINE_VERSION, 
         RDB$GET_CONTEXT('SYSTEM', 'NETWORK_PROTOCOL') AS NETWORK_PROTOCOL,
         RDB$GET_CONTEXT('SYSTEM', 'CLIENT_ADDRESS'  ) AS CLIENT_ADDRESS,
         RDB$GET_CONTEXT('SYSTEM', 'ISOLATION_LEVEL' ) AS ISOLATION_LEVEL,
         RDB$GET_CONTEXT('SYSTEM', 'TRANSACTION_ID'  ) AS TRANSACTION_ID,
         RDB$GET_CONTEXT('SYSTEM', 'SESSION_ID'      ) AS SESSION_ID,
         RDB$GET_CONTEXT('SYSTEM', 'CURRENT_USER'    ) AS CRNT_USER,
         RDB$GET_CONTEXT('SYSTEM', 'CURRENT_ROLE'    ) AS CRNT_ROLE
    FROM RDB$DATABASE;`;

export function selectAllFieldRecordsQuery(fieldName: string, tableName: string): string {
  return `SELECT ${fieldName} FROM ${tableName}`;
}

export function getViewsQuery(): string {
  return `SELECT TRIM(RDB$RELATION_NAME) AS VIEW_NAME
            FROM RDB$RELATIONS
           WHERE RDB$VIEW_BLR IS NOT NULL
             AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function viewColumnsQuery(viewName: string): string {
  return `SELECT TRIM(r.RDB$FIELD_NAME) AS FIELD_NAME,
         CASE f.RDB$FIELD_TYPE
           WHEN 261 THEN 'BLOB'
           WHEN 14  THEN 'CHAR'
           WHEN 40  THEN 'CSTRING'
           WHEN 11  THEN 'D_FLOAT'
           WHEN 27  THEN 'DOUBLE'
           WHEN 10  THEN 'FLOAT'
           WHEN 16  THEN 'INT64'
           WHEN 8   THEN 'INTEGER'
           WHEN 9   THEN 'QUAD'
           WHEN 7   THEN 'SMALLINT'
           WHEN 12  THEN 'DATE'
           WHEN 13  THEN 'TIME'
           WHEN 35  THEN 'TIMESTAMP'
           WHEN 37  THEN 'VARCHAR'
           ELSE 'UNKNOWN'
         END AS FIELD_TYPE,
            COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS FIELD_LENGTH,
            CASE WHEN r.RDB$NULL_FLAG = 1 THEN 1 ELSE 0 END AS NOT_NULL,
            r.RDB$FIELD_POSITION AS FIELD_POSITION
       FROM RDB$RELATION_FIELDS r
  LEFT JOIN RDB$FIELDS f ON r.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
      WHERE r.RDB$RELATION_NAME = '${viewName}'
   ORDER BY r.RDB$FIELD_POSITION;`;
}

export function getStoredProceduresQuery(): string {
  return `SELECT TRIM(RDB$PROCEDURE_NAME) AS PROCEDURE_NAME
            FROM RDB$PROCEDURES
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function procedureParametersQuery(procedureName: string): string {
  return `SELECT TRIM(pp.RDB$PARAMETER_NAME) AS PARAM_NAME,
                 pp.RDB$PARAMETER_TYPE AS PARAM_TYPE,
                 CASE f.RDB$FIELD_TYPE
                   WHEN 261 THEN 'BLOB'
                   WHEN 14  THEN 'CHAR'
                   WHEN 40  THEN 'CSTRING'
                   WHEN 11  THEN 'D_FLOAT'
                   WHEN 27  THEN 'DOUBLE'
                   WHEN 10  THEN 'FLOAT'
                   WHEN 16  THEN 'INT64'
                   WHEN 8   THEN 'INTEGER'
                   WHEN 9   THEN 'QUAD'
                   WHEN 7   THEN 'SMALLINT'
                   WHEN 12  THEN 'DATE'
                   WHEN 13  THEN 'TIME'
                   WHEN 35  THEN 'TIMESTAMP'
                   WHEN 37  THEN 'VARCHAR'
                   ELSE 'UNKNOWN'
                 END AS FIELD_TYPE,
                 COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS FIELD_LENGTH,
                 f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
                 f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
                 f.RDB$FIELD_SCALE AS FIELD_SCALE
            FROM RDB$PROCEDURE_PARAMETERS pp
       LEFT JOIN RDB$FIELDS f ON pp.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
           WHERE pp.RDB$PROCEDURE_NAME = '${procedureName}'
        ORDER BY pp.RDB$PARAMETER_TYPE, pp.RDB$PARAMETER_NUMBER;`;
}

export function getTriggersQuery(): string {
  return `SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME,
                 TRIM(RDB$RELATION_NAME) AS TABLE_NAME,
                 RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
                 RDB$TRIGGER_INACTIVE AS INACTIVE
            FROM RDB$TRIGGERS
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function getGeneratorsQuery(): string {
  return `SELECT TRIM(RDB$GENERATOR_NAME) AS GENERATOR_NAME
            FROM RDB$GENERATORS
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

/**
 * DEFAULT_SOURCE/CHECK_SOURCE are cast the same way procedure/trigger/view source text already is
 * elsewhere in this file (VARCHAR(MAX_SOURCE_CAST_LENGTH) CHARACTER SET UTF8) — a domain's CHECK
 * expression, in particular, has no inherent length cap. Both come back as literal DDL-fragment
 * text ("DEFAULT 0", "CHECK (VALUE >= 0)"), confirmed directly against a live Firebird 6.0 server —
 * DEFAULT_SOURCE needs its "DEFAULT " prefix stripped before reuse the same way
 * schema-graph.ts's normalizeDefault() already does for table columns; CHECK_SOURCE already
 * includes its own "CHECK (...)" wrapper and can be appended to CREATE/ALTER DOMAIN as-is.
 */
export function getDomainsQuery(): string {
  return `SELECT TRIM(RDB$FIELD_NAME) AS DOMAIN_NAME,
                 CASE RDB$FIELD_TYPE
                   WHEN 261 THEN 'BLOB'
                   WHEN 14  THEN 'CHAR'
                   WHEN 40  THEN 'CSTRING'
                   WHEN 11  THEN 'D_FLOAT'
                   WHEN 27  THEN 'DOUBLE'
                   WHEN 10  THEN 'FLOAT'
                   WHEN 16  THEN 'INT64'
                   WHEN 8   THEN 'INTEGER'
                   WHEN 9   THEN 'QUAD'
                   WHEN 7   THEN 'SMALLINT'
                   WHEN 12  THEN 'DATE'
                   WHEN 13  THEN 'TIME'
                   WHEN 35  THEN 'TIMESTAMP'
                   WHEN 37  THEN 'VARCHAR'
                   WHEN 23  THEN 'BOOLEAN'
                   ELSE 'UNKNOWN'
                 END AS DOMAIN_TYPE,
                 COALESCE(RDB$CHARACTER_LENGTH, RDB$FIELD_LENGTH) AS FIELD_LENGTH,
                 RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
                 RDB$FIELD_PRECISION AS FIELD_PRECISION,
                 RDB$FIELD_SCALE AS FIELD_SCALE,
                 CASE WHEN RDB$NULL_FLAG = 1 THEN 1 ELSE 0 END AS NOT_NULL,
                 CAST(RDB$DEFAULT_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS DEFAULT_SOURCE,
                 CAST(RDB$VALIDATION_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS CHECK_SOURCE
            FROM RDB$FIELDS
           WHERE RDB$FIELD_NAME NOT STARTING WITH 'RDB$'
             AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function getRolesQuery(): string {
  return `SELECT TRIM(RDB$ROLE_NAME) AS ROLE_NAME
            FROM RDB$ROLES
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function getExceptionsQuery(): string {
  return `SELECT TRIM(RDB$EXCEPTION_NAME) AS EXCEPTION_NAME,
                 RDB$MESSAGE AS MESSAGE
            FROM RDB$EXCEPTIONS
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

/**
 * SEC$USERS is Firebird 3+'s SQL-visible view of the security database attached to the current
 * connection — lists every login, not just ones tied to this particular database.
 */
export function getUsersQuery(): string {
  return `SELECT TRIM(SEC$USER_NAME) AS USER_NAME
            FROM SEC$USERS
        ORDER BY 1;`;
}

/**
 * Escapes a value for use inside a single-quoted SQL string literal (doubles embedded quotes).
 * Only for cases like CREATE/ALTER USER's PASSWORD clause, which has no parameterized-query
 * equivalent since it's DDL — identifiers in these same statements are validated separately via
 * assertValidIdentifier(), never string-escaped, since Firebird identifiers can't be
 * parameterized either and must instead be restricted to a safe character set. Exported so
 * project-model.ts's CREATE EXCEPTION/CREATE USER DDL builders (Database Projects, which also
 * embed values in single-quoted literals with no parameterized-DDL alternative) can reuse it
 * rather than a second, drifting copy.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function createUserQuery(userName: string, password: string): string {
  assertValidIdentifier(userName, "user name");
  return `CREATE USER ${userName} PASSWORD '${escapeSqlLiteral(password)}';`;
}

export function alterUserPasswordQuery(userName: string, password: string): string {
  assertValidIdentifier(userName, "user name");
  return `ALTER USER ${userName} PASSWORD '${escapeSqlLiteral(password)}';`;
}

export function dropUserQuery(userName: string): string {
  assertValidIdentifier(userName, "user name");
  return `DROP USER ${userName};`;
}

export function createRoleQuery(roleName: string): string {
  assertValidIdentifier(roleName, "role name");
  return `CREATE ROLE ${roleName};`;
}

/**
 * Lists standalone, user-created indexes on a table — explicitly excludes indexes Firebird
 * auto-creates to back a PRIMARY KEY/UNIQUE/FOREIGN KEY constraint (already shown per-column via
 * the primary/foreign/unique icons tableInfoQuery() drives) and system-generated indexes, so this
 * doesn't just duplicate what the column list already shows.
 */
export function getIndexesQuery(tableName: string): string {
  return `SELECT TRIM(i.RDB$INDEX_NAME) AS INDEX_NAME,
                 i.RDB$UNIQUE_FLAG AS IS_UNIQUE,
                 CASE WHEN i.RDB$INDEX_INACTIVE = 1 THEN 0 ELSE 1 END AS IS_ACTIVE,
                 CAST(LIST(TRIM(s.RDB$FIELD_NAME), ', ') AS VARCHAR(500)) AS COLUMNS
            FROM RDB$INDICES i
            JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
       LEFT JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$INDEX_NAME = i.RDB$INDEX_NAME
           WHERE TRIM(i.RDB$RELATION_NAME) = '${tableName}'
             AND rc.RDB$CONSTRAINT_NAME IS NULL
             AND (i.RDB$SYSTEM_FLAG IS NULL OR i.RDB$SYSTEM_FLAG = 0)
        GROUP BY i.RDB$INDEX_NAME, i.RDB$UNIQUE_FLAG, i.RDB$INDEX_INACTIVE
        ORDER BY 1;`;
}

export function createIndexQuery(indexName: string, tableName: string, columns: string[], unique: boolean): string {
  assertValidIdentifier(indexName, "index name");
  assertValidIdentifier(tableName, "table name");
  if (columns.length === 0) {
    throw new Error("At least one column is required to create an index.");
  }
  columns.forEach(column => assertValidIdentifier(column, "column name"));
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${indexName} ON ${tableName} (${columns.join(", ")});`;
}

export function dropIndexQuery(indexName: string): string {
  assertValidIdentifier(indexName, "index name");
  return `DROP INDEX ${indexName};`;
}

/**
 * Firebird's own metadata tables (RDB$RELATIONS, RDB$FIELDS, MON$ATTACHMENTS, etc.), hidden from
 * the regular Tables list by RDB$SYSTEM_FLAG = 1. Only queried when the user opts in via the
 * firebird.showSystemObjects setting — most users never need to browse these directly.
 */
export function getSystemTablesQuery(): string {
  return `SELECT TRIM(RDB$RELATION_NAME) AS TABLE_NAME
            FROM RDB$RELATIONS
           WHERE RDB$SYSTEM_FLAG = 1
        ORDER BY 1;`;
}

/**
 * Max characters that fit in a CAST(... AS VARCHAR(n) CHARACTER SET UTF8): Firebird caps a
 * single VARCHAR at 32767 bytes total (2 of which are the length prefix), and UTF8 can use up
 * to 4 bytes/char, so 32765 / 4 = 8191. The CHARACTER SET is pinned explicitly rather than left
 * to inherit the connection's negotiated charset (node-firebird defaults new connections to
 * UTF8 lc_ctype) — without it, `CAST(... AS VARCHAR(32000))` needs up to 128000 bytes and fails
 * with "SQL error code = -204, Data type unknown, Implementation limit exceeded, COLUMN".
 */
export const MAX_SOURCE_CAST_LENGTH = 8191;

export function getProcedureBodyQuery(procedureName: string): string {
  return `SELECT TRIM(RDB$PROCEDURE_NAME) AS PROCEDURE_NAME,
                 CAST(RDB$PROCEDURE_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS PROCEDURE_SOURCE
            FROM RDB$PROCEDURES
           WHERE TRIM(RDB$PROCEDURE_NAME) = '${procedureName}';`;
}

export function getTriggerBodyQuery(triggerName: string): string {
  return `SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME,
                 TRIM(RDB$RELATION_NAME) AS TABLE_NAME,
                 RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
                 CAST(RDB$TRIGGER_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS TRIGGER_SOURCE
            FROM RDB$TRIGGERS
           WHERE TRIM(RDB$TRIGGER_NAME) = '${triggerName}';`;
}

export function getViewDefinitionQuery(viewName: string): string {
  return `SELECT TRIM(RDB$RELATION_NAME) AS VIEW_NAME,
                 CAST(RDB$VIEW_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS VIEW_SOURCE
            FROM RDB$RELATIONS
           WHERE TRIM(RDB$RELATION_NAME) = '${viewName}';`;
}

/**
 * Every non-system procedure's full source, for the Database Projects Extract command — the
 * same CAST(...) truncation-safe pattern as getProcedureBodyQuery(), just for all procedures in
 * one round trip instead of one query per procedure.
 */
export function getAllProcedureSourcesQuery(): string {
  return `SELECT TRIM(RDB$PROCEDURE_NAME) AS PROCEDURE_NAME,
                 CAST(RDB$PROCEDURE_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS PROCEDURE_SOURCE
            FROM RDB$PROCEDURES
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

/**
 * Every non-system procedure's parameters (input and output), one round trip — needed to
 * reconstruct a parameterized procedure's DDL, since RDB$PROCEDURE_SOURCE excludes the parameter
 * list and RETURNS clause entirely (confirmed directly against a live server). RDB$PARAMETER_TYPE
 * is 0 for an input parameter, 1 for an output one; ordered so input params come back in
 * declaration order followed by output params in declaration order.
 */
export function getAllProcedureParametersQuery(): string {
  return `SELECT TRIM(pp.RDB$PROCEDURE_NAME) AS PROCEDURE_NAME,
                 TRIM(pp.RDB$PARAMETER_NAME) AS PARAM_NAME,
                 pp.RDB$PARAMETER_TYPE AS PARAM_TYPE,
                 CASE f.RDB$FIELD_TYPE
                   WHEN 261 THEN 'BLOB'
                   WHEN 14  THEN 'CHAR'
                   WHEN 40  THEN 'CSTRING'
                   WHEN 11  THEN 'D_FLOAT'
                   WHEN 27  THEN 'DOUBLE'
                   WHEN 10  THEN 'FLOAT'
                   WHEN 16  THEN 'INT64'
                   WHEN 8   THEN 'INTEGER'
                   WHEN 9   THEN 'QUAD'
                   WHEN 7   THEN 'SMALLINT'
                   WHEN 12  THEN 'DATE'
                   WHEN 13  THEN 'TIME'
                   WHEN 35  THEN 'TIMESTAMP'
                   WHEN 37  THEN 'VARCHAR'
                   ELSE 'UNKNOWN'
                 END AS FIELD_TYPE,
                 COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS FIELD_LENGTH,
                 f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
                 f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
                 f.RDB$FIELD_SCALE AS FIELD_SCALE
            FROM RDB$PROCEDURE_PARAMETERS pp
       LEFT JOIN RDB$FIELDS f ON pp.RDB$FIELD_SOURCE = f.RDB$FIELD_NAME
           WHERE pp.RDB$PROCEDURE_NAME IN (SELECT RDB$PROCEDURE_NAME FROM RDB$PROCEDURES WHERE RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY pp.RDB$PROCEDURE_NAME, pp.RDB$PARAMETER_TYPE, pp.RDB$PARAMETER_NUMBER;`;
}

/** Every non-system trigger's full source, one round trip — see getAllProcedureSourcesQuery(). */
export function getAllTriggerSourcesQuery(): string {
  return `SELECT TRIM(RDB$TRIGGER_NAME) AS TRIGGER_NAME,
                 TRIM(RDB$RELATION_NAME) AS TABLE_NAME,
                 RDB$TRIGGER_TYPE AS TRIGGER_TYPE,
                 CASE WHEN RDB$TRIGGER_INACTIVE = 1 THEN 1 ELSE 0 END AS INACTIVE,
                 CAST(RDB$TRIGGER_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS TRIGGER_SOURCE
            FROM RDB$TRIGGERS
           WHERE (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

/** Every non-system view's full source, one round trip — see getAllProcedureSourcesQuery(). */
export function getAllViewSourcesQuery(): string {
  return `SELECT TRIM(RDB$RELATION_NAME) AS VIEW_NAME,
                 CAST(RDB$VIEW_SOURCE AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS VIEW_SOURCE
            FROM RDB$RELATIONS
           WHERE RDB$VIEW_BLR IS NOT NULL
             AND (RDB$SYSTEM_FLAG IS NULL OR RDB$SYSTEM_FLAG = 0)
        ORDER BY 1;`;
}

export function dropProcedureQuery(procedureName: string): string {
  return `DROP PROCEDURE ${procedureName};`;
}

export function dropTriggerQuery(triggerName: string): string {
  return `DROP TRIGGER ${triggerName};`;
}

export function dropViewQuery(viewName: string): string {
  return `DROP VIEW ${viewName};`;
}

export function dropGeneratorQuery(generatorName: string): string {
  return `DROP SEQUENCE ${generatorName};`;
}

export function dropDomainQuery(domainName: string): string {
  return `DROP DOMAIN ${domainName};`;
}

export function dropRoleQuery(roleName: string): string {
  return `DROP ROLE ${roleName};`;
}

export function dropExceptionQuery(exceptionName: string): string {
  return `DROP EXCEPTION ${exceptionName};`;
}

export function setGeneratorValueQuery(generatorName: string, value: number): string {
  return `SET GENERATOR ${generatorName} TO ${value};`;
}

export function createGeneratorQuery(generatorName: string): string {
  assertValidIdentifier(generatorName, "generator name");
  return `CREATE SEQUENCE ${generatorName};`;
}

/** Read-only "peek" at a generator/sequence's current value — used by Object Search, since generators have no other non-destructive inspection action (unlike setGeneratorValue(), which prompts to overwrite it). */
export function generatorCurrentValueQuery(generatorName: string): string {
  assertValidIdentifier(generatorName, "generator name");
  return `SELECT GEN_ID(${generatorName}, 0) AS CURRENT_VALUE FROM RDB$DATABASE;`;
}

/**
 * Grants recorded against a table/view/procedure/role, read from RDB$USER_PRIVILEGES — confirmed
 * directly against a live Firebird server that RDB$RELATION_NAME (despite its name) holds the
 * securable object's name for all of these object types, not just relations, so one query by name
 * works regardless of which kind of object it is. RDB$PRIVILEGE is a single-letter code (S=SELECT,
 * I=INSERT, U=UPDATE, D=DELETE, R=REFERENCES, X=EXECUTE, M=role membership) mapped here to a
 * friendly name; RDB$FIELD_NAME is only non-null for a column-level grant (e.g. UPDATE on one column).
 */
export function getObjectPrivilegesQuery(objectName: string): string {
  assertValidIdentifier(objectName, "object name");
  return `SELECT TRIM(p.RDB$USER) AS GRANTEE,
                 TRIM(p.RDB$GRANTOR) AS GRANTOR,
                 CASE p.RDB$PRIVILEGE
                   WHEN 'S' THEN 'SELECT'
                   WHEN 'I' THEN 'INSERT'
                   WHEN 'U' THEN 'UPDATE'
                   WHEN 'D' THEN 'DELETE'
                   WHEN 'R' THEN 'REFERENCES'
                   WHEN 'X' THEN 'EXECUTE'
                   WHEN 'M' THEN 'MEMBER OF'
                   ELSE p.RDB$PRIVILEGE
                 END AS PRIVILEGE,
                 CASE WHEN p.RDB$GRANT_OPTION = 1 THEN 'YES' ELSE 'NO' END AS GRANT_OPTION,
                 TRIM(p.RDB$FIELD_NAME) AS COLUMN_NAME
            FROM RDB$USER_PRIVILEGES p
           WHERE TRIM(p.RDB$RELATION_NAME) = '${objectName}'
        ORDER BY GRANTEE, PRIVILEGE, COLUMN_NAME;`;
}

/**
 * "Create new object" scaffolds — opened in a new SQL editor for the user to fill in and run
 * manually, the same way NodeProcedure#editProcedure()/NodeView#editView()/
 * NodeTrigger#editTrigger() open an ALTER scaffold for an existing object. Names come from user
 * input (an input box), so they're validated the same way createUserQuery/createRoleQuery are —
 * DDL identifiers can't be parameterized, only restricted to a safe character set.
 */
export function createViewScaffold(viewName: string): string {
  assertValidIdentifier(viewName, "view name");
  return `CREATE VIEW ${viewName} AS\nSELECT /* column_list */ FROM /* table_name */;`;
}

export function createProcedureScaffold(procedureName: string): string {
  assertValidIdentifier(procedureName, "procedure name");
  return `CREATE PROCEDURE ${procedureName}\nAS\nBEGIN\n  /* procedure body */\nEND`;
}

export function createTriggerScaffold(triggerName: string): string {
  assertValidIdentifier(triggerName, "trigger name");
  return `CREATE TRIGGER ${triggerName}\nACTIVE BEFORE INSERT ON /* table_name */\nAS\nBEGIN\n  /* trigger body */\nEND`;
}

export function createDomainScaffold(domainName: string): string {
  assertValidIdentifier(domainName, "domain name");
  return `CREATE DOMAIN ${domainName} AS INTEGER;\n-- Adjust the data type below, and add DEFAULT/NOT NULL/CHECK constraints as needed.`;
}

/**
 * Scaffold for altering an existing domain, pre-filled with its current (simplified) type.
 * FIELD_PRECISION/FIELD_SCALE aren't factored in, matching the same simplification the domain
 * tree item's own tooltip already uses.
 */
export function alterDomainScaffold(domain: {
  DOMAIN_NAME: string;
  DOMAIN_TYPE?: string;
  FIELD_LENGTH?: number;
  NOT_NULL?: number | boolean;
}): string {
  const name = domain.DOMAIN_NAME.trim();
  assertValidIdentifier(name, "domain name");
  const type = domain.DOMAIN_TYPE?.trim() || "UNKNOWN";
  const length = domain.FIELD_LENGTH || 0;
  const notNull = domain.NOT_NULL ? " NOT NULL" : "";
  return `-- Current definition: ${name} ${type}(${length})${notNull}\nALTER DOMAIN ${name} TYPE ${type}(${length});`;
}

/**
 * Returns the primary key column(s) of a table, in key order — used by the editable results
 * grid to target UPDATE/DELETE statements at a single row instead of matching every column.
 */
export function getPrimaryKeyColumnsQuery(tableName: string): string {
  return `SELECT TRIM(s.RDB$FIELD_NAME) AS FIELD_NAME
            FROM RDB$RELATION_CONSTRAINTS rc
            JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
           WHERE rc.RDB$RELATION_NAME = '${tableName}'
             AND rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
        ORDER BY s.RDB$FIELD_POSITION;`;
}

/**
 * Every table's primary key constraint name (0 or 1 row per table) — needed to DROP CONSTRAINT
 * before adding a new primary key, since ALTER TABLE can't just "replace" one. Used by the
 * Schema Designer when a table's set of primary key columns changes.
 */
export function getAllPrimaryKeyConstraintNamesQuery(): string {
  return `SELECT TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME,
                 TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME
            FROM RDB$RELATION_CONSTRAINTS rc
           WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY';`;
}

/**
 * Returns every column of every table in the database, one row per column, with a primary-key
 * flag and default value — used by the Schema Designer to build its whole-database graph in a
 * single round trip instead of one tableInfoQuery() per table.
 */
export function getSchemaColumnsQuery(): string {
  return `SELECT TRIM(r.RDB$RELATION_NAME) AS TABLE_NAME,
                 TRIM(r.RDB$FIELD_NAME) AS FIELD_NAME,
                 CASE f.RDB$FIELD_TYPE
                   WHEN 261 THEN 'BLOB'
                   WHEN 14  THEN 'CHAR'
                   WHEN 40  THEN 'CSTRING'
                   WHEN 11  THEN 'D_FLOAT'
                   WHEN 27  THEN 'DOUBLE'
                   WHEN 10  THEN 'FLOAT'
                   WHEN 16  THEN 'INT64'
                   WHEN 8   THEN 'INTEGER'
                   WHEN 9   THEN 'QUAD'
                   WHEN 7   THEN 'SMALLINT'
                   WHEN 12  THEN 'DATE'
                   WHEN 13  THEN 'TIME'
                   WHEN 35  THEN 'TIMESTAMP'
                   WHEN 37  THEN 'VARCHAR'
                   ELSE 'UNKNOWN'
                 END AS FIELD_TYPE,
                 COALESCE(f.RDB$CHARACTER_LENGTH, f.RDB$FIELD_LENGTH) AS FIELD_LENGTH,
                 f.RDB$FIELD_SUB_TYPE AS FIELD_SUB_TYPE,
                 f.RDB$FIELD_PRECISION AS FIELD_PRECISION,
                 f.RDB$FIELD_SCALE AS FIELD_SCALE,
                 CASE WHEN r.RDB$NULL_FLAG = 1 THEN 1 ELSE 0 END AS NOT_NULL,
                 r.RDB$FIELD_POSITION AS FIELD_POSITION,
                 CASE WHEN pk.RDB$FIELD_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
                 CAST(r.RDB$DEFAULT_SOURCE AS VARCHAR(100) CHARACTER SET UTF8) AS DFLT_VALUE
            FROM RDB$RELATION_FIELDS r
            JOIN RDB$RELATIONS rel ON rel.RDB$RELATION_NAME = r.RDB$RELATION_NAME
       LEFT JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = r.RDB$FIELD_SOURCE
       LEFT JOIN (
                 SELECT s.RDB$FIELD_NAME, rc.RDB$RELATION_NAME
                   FROM RDB$RELATION_CONSTRAINTS rc
                   JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
                  WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
               ) pk ON pk.RDB$RELATION_NAME = r.RDB$RELATION_NAME AND pk.RDB$FIELD_NAME = r.RDB$FIELD_NAME
           WHERE rel.RDB$VIEW_BLR IS NULL
             AND (rel.RDB$SYSTEM_FLAG IS NULL OR rel.RDB$SYSTEM_FLAG = 0)
        ORDER BY TABLE_NAME, r.RDB$FIELD_POSITION;`;
}

/**
 * Returns every foreign key relationship in the database (FK column(s) -> referenced table and
 * column(s)), pairing up composite-key columns by their position within the key — used to draw
 * relationship lines in the schema visualizer.
 */
export function getForeignKeysQuery(): string {
  return `SELECT TRIM(rc.RDB$RELATION_NAME) AS TABLE_NAME,
                 TRIM(seg.RDB$FIELD_NAME) AS COLUMN_NAME,
                 TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
                 TRIM(rc2.RDB$RELATION_NAME) AS REF_TABLE_NAME,
                 TRIM(seg2.RDB$FIELD_NAME) AS REF_COLUMN_NAME
            FROM RDB$REF_CONSTRAINTS refc
            JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$CONSTRAINT_NAME = refc.RDB$CONSTRAINT_NAME
            JOIN RDB$INDEX_SEGMENTS seg ON seg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
            JOIN RDB$RELATION_CONSTRAINTS rc2 ON rc2.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
            JOIN RDB$INDEX_SEGMENTS seg2 ON seg2.RDB$INDEX_NAME = rc2.RDB$INDEX_NAME
                                         AND seg2.RDB$FIELD_POSITION = seg.RDB$FIELD_POSITION
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, seg.RDB$FIELD_POSITION;`;
}

/**
 * Poll-friendly activity snapshot for the Live Profiler: one row per connection (excluding the
 * profiler's own dedicated connection, and internal engine attachments like the garbage
 * collector/cache writer, which have no MON$REMOTE_ADDRESS), each attachment's current
 * page/record I-O counters (cumulative — the caller diffs successive polls into a rate), and,
 * if there is one, its most recently started active statement and transaction. Supersedes the
 * one-shot connection snapshot `NodeDatabase#monitorDatabase()` used to run directly.
 *
 * Verified directly against a real Firebird 3.0 server (a scratch database, via isql-fb) before
 * being written into this file — MON$STAT_GROUP = 1 selects the *attachment*-level stat row for
 * a given MON$STAT_ID (0 = database, 1 = attachment, 2 = transaction, 3 = statement); without
 * it, a MON$STAT_ID could in principle join to the wrong "level" of stats.
 *
 * "Most recent active statement" is approximated as the highest MON$STATEMENT_ID currently in
 * state 1 (active, i.e. a request is genuinely executing right now) for that attachment — ids
 * are assigned sequentially, so the max id among active ones is the most recently started. An
 * attachment can genuinely have more than one active statement at once; this only surfaces one,
 * by design, to keep the activity grain at "one row per connection" rather than "one row per
 * statement" (multiplying out every combination would be noisier, not more useful, for a
 * connection-level activity view).
 *
 * The transaction side deliberately does *not* filter on MON$STATE = 1: unlike a statement,
 * every row MON$TRANSACTIONS holds at all is already an open (not yet committed/rolled-back)
 * transaction — MON$STATE there means "a request is executing under this transaction right now"
 * (1) vs. "open but idle between statements" (0), not "open vs. done". Filtering to state 1 would
 * silently hide the single most common case the Sessions view (phase 5, below) exists to show: a
 * connection sitting on an open transaction between statements. This was tried with the filter
 * first and caught live against a real server — see that phase's note.
 *
 * The transaction-level columns added for the Live Profiler's "Sessions" view (phase 5,
 * `docs/roadmap/live-profiler.md`) — MON$RECORD_WAITS/MON$RECORD_CONFLICTS (also from the
 * already-joined attachment-level MON$RECORD_STATS row), MON$TIMESTAMP/MON$LOCK_TIMEOUT/
 * MON$AUTO_COMMIT/MON$READ_ONLY off `tx`, and MON$DATABASE.MON$OLDEST_ACTIVE (the database's
 * single row, via a scalar subquery so this stays one query) — verified against a real Firebird
 * 6.0 server at `/opt/firebird` (a scratch database, via `isql`/`node-firebird`). Findings:
 *   - MON$LOCK_TIMEOUT reads back exactly what each transaction was opened with (-1 infinite /
 *     0 no-wait / N seconds), and MON$DATABASE.MON$OLDEST_ACTIVE correctly names the oldest open
 *     transaction across all attachments.
 *   - MON$RECORD_WAITS increments on a plain READ COMMITTED WAIT (or NO WAIT) lock conflict
 *     against a row another transaction has already updated. MON$RECORD_CONFLICTS, despite the
 *     name, did **not** increment for that same scenario — only for a SNAPSHOT/CONCURRENCY
 *     isolation transaction whose snapshot was invalidated by another transaction's committed
 *     update in between (the classic MVCC optimistic-conflict case). Both incremented together
 *     there. So "Conflicts/s" in the Sessions view is a signal for snapshot invalidation
 *     specifically, not every kind of lock contention — "Waits/s" is the broader one.
 *   - This same run is what caught the MON$STATE = 1 bug described above: an idle-in-transaction
 *     connection had a real open transaction but showed every tx-derived column as NULL until
 *     the filter was removed.
 * Firebird's monitoring tables have no blocker/waiter identity (no lock-wait graph like
 * PostgreSQL's pg_locks) — MON$RECORD_WAITS/CONFLICTS are just per-attachment cumulative
 * counters, and MON$OLDEST_ACTIVE flags whichever transaction is currently the oldest, i.e. most
 * likely to be holding back garbage collection — the closest analog Firebird exposes to "this
 * session may be blocking others".
 */
export function profilerActivityQuery(): string {
  return `SELECT a.MON$ATTACHMENT_ID AS ATTACHMENT_ID,
                 a.MON$USER AS USER_NAME,
                 a.MON$REMOTE_ADDRESS AS REMOTE_ADDRESS,
                 a.MON$STATE AS ATTACHMENT_STATE,
                 a.MON$TIMESTAMP AS CONNECTED_AT,
                 io.MON$PAGE_READS AS PAGE_READS,
                 io.MON$PAGE_WRITES AS PAGE_WRITES,
                 io.MON$PAGE_FETCHES AS PAGE_FETCHES,
                 io.MON$PAGE_MARKS AS PAGE_MARKS,
                 rs.MON$RECORD_SEQ_READS AS SEQ_READS,
                 rs.MON$RECORD_IDX_READS AS IDX_READS,
                 rs.MON$RECORD_WAITS AS RECORD_WAITS,
                 rs.MON$RECORD_CONFLICTS AS RECORD_CONFLICTS,
                 stmt.MON$STATEMENT_ID AS STATEMENT_ID,
                 CAST(stmt.MON$SQL_TEXT AS VARCHAR(${MAX_SOURCE_CAST_LENGTH}) CHARACTER SET UTF8) AS SQL_TEXT,
                 tx.MON$TRANSACTION_ID AS TRANSACTION_ID,
                 tx.MON$ISOLATION_MODE AS ISOLATION_MODE,
                 tx.MON$TIMESTAMP AS TX_STARTED_AT,
                 tx.MON$LOCK_TIMEOUT AS LOCK_TIMEOUT,
                 tx.MON$AUTO_COMMIT AS TX_AUTO_COMMIT,
                 tx.MON$READ_ONLY AS TX_READ_ONLY,
                 (SELECT MON$OLDEST_ACTIVE FROM MON$DATABASE) AS DB_OLDEST_ACTIVE
            FROM MON$ATTACHMENTS a
       LEFT JOIN MON$IO_STATS io ON io.MON$STAT_ID = a.MON$STAT_ID AND io.MON$STAT_GROUP = 1
       LEFT JOIN MON$RECORD_STATS rs ON rs.MON$STAT_ID = a.MON$STAT_ID AND rs.MON$STAT_GROUP = 1
       LEFT JOIN (
                 SELECT MON$ATTACHMENT_ID, MAX(MON$STATEMENT_ID) AS MON$STATEMENT_ID
                   FROM MON$STATEMENTS
                  WHERE MON$STATE = 1
               GROUP BY MON$ATTACHMENT_ID
               ) active_stmt ON active_stmt.MON$ATTACHMENT_ID = a.MON$ATTACHMENT_ID
       LEFT JOIN MON$STATEMENTS stmt ON stmt.MON$STATEMENT_ID = active_stmt.MON$STATEMENT_ID
       LEFT JOIN (
                 SELECT MON$ATTACHMENT_ID, MAX(MON$TRANSACTION_ID) AS MON$TRANSACTION_ID
                   FROM MON$TRANSACTIONS
               GROUP BY MON$ATTACHMENT_ID
               ) active_tx ON active_tx.MON$ATTACHMENT_ID = a.MON$ATTACHMENT_ID
       LEFT JOIN MON$TRANSACTIONS tx ON tx.MON$TRANSACTION_ID = active_tx.MON$TRANSACTION_ID
           WHERE a.MON$REMOTE_ADDRESS IS NOT NULL
             AND a.MON$ATTACHMENT_ID <> CURRENT_CONNECTION
        ORDER BY a.MON$ATTACHMENT_ID;`;
}

/**
 * Force-detaches a connection from the Live Profiler's "Kill" action (`docs/roadmap/live-profiler.md`
 * phase 3). Deleting from MON$ATTACHMENTS is Firebird's documented mechanism for this -- there is no
 * separate DDL/admin statement for it.
 */
export function killAttachmentQuery(attachmentId: number): string {
  if (!Number.isInteger(attachmentId)) {
    throw new Error("Invalid attachment id.");
  }
  return `DELETE FROM MON$ATTACHMENTS WHERE MON$ATTACHMENT_ID = ${attachmentId};`;
}

/** Rolls back a transaction from the Live Profiler's "Rollback" action -- same MON$ mechanism as killAttachmentQuery(). */
export function rollbackTransactionQuery(transactionId: number): string {
  if (!Number.isInteger(transactionId)) {
    throw new Error("Invalid transaction id.");
  }
  return `DELETE FROM MON$TRANSACTIONS WHERE MON$TRANSACTION_ID = ${transactionId};`;
}

/**
 * The server's hard cap on `gbak -PAR <n>` (docs/roadmap/backup-restore-options.md, phase 4).
 *
 * `RDB$CONFIG` is a virtual table (Firebird 4+) exposing the server's effective configuration.
 * `MaxParallelWorkers` is the ceiling; asking gbak for more produces a real warning — confirmed
 * live against Firebird 6.0: `gbak -PAR 4` against a server with the default `MaxParallelWorkers`
 * of 1 prints "WARNING:Wrong parallel workers value 4, valid range are from 1 to 1" and silently
 * proceeds single-threaded. Querying this first means only usable values are ever offered.
 */
export function getMaxParallelWorkersQuery(): string {
  return `SELECT RDB$CONFIG_VALUE AS MAX_WORKERS
          FROM RDB$CONFIG
          WHERE RDB$CONFIG_NAME = 'MaxParallelWorkers'`;
}

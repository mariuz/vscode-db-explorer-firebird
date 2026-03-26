# SQL Snippets Reference

The extension ships with **45 Firebird SQL snippets** that speed up writing common SQL and PSQL patterns. All snippets are prefixed with `fb` and are available in any `.sql` file.

## How to Use Snippets

1. Open a `.sql` file.
2. Type the snippet **prefix** (e.g., `fbselect`) and press `Tab` or select it from the IntelliSense suggestion list.
3. Fill in the highlighted placeholders — press `Tab` to jump to the next one.

> **Tip:** You can also trigger the snippet list by pressing `Ctrl+Space` in a `.sql` file.

---

## Data Manipulation (DML)

### `fbselect` — SELECT Statement

```sql
SELECT <columns>
FROM <table>
WHERE <condition>;
```

### `fbjoin` — SELECT with JOIN

```sql
SELECT <columns>
FROM <table1> <alias1>
INNER JOIN <table2> <alias2> ON <alias1>.<col> = <alias2>.<col>
WHERE <condition>;
```

Choices available: `INNER`, `LEFT`, `RIGHT`, `FULL`.

### `fbfirst` — SELECT FIRST SKIP (pagination)

```sql
SELECT FIRST <n> SKIP <offset>
  <columns>
FROM <table>
WHERE <condition>;
```

### `fbinsert` — INSERT INTO

```sql
INSERT INTO <table> (<columns>)
VALUES (<values>);
```

### `fbinsertret` — INSERT INTO … RETURNING

```sql
INSERT INTO <table> (<columns>)
VALUES (<values>)
RETURNING <columns>;
```

### `fbupdate` — UPDATE SET

```sql
UPDATE <table>
SET <column> = <value>
WHERE <condition>;
```

### `fbdelete` — DELETE FROM

```sql
DELETE FROM <table>
WHERE <condition>;
```

### `fbmerge` — MERGE INTO (upsert)

```sql
MERGE INTO <target> t
USING <source> s
ON t.<key> = s.<key>
WHEN MATCHED THEN
  UPDATE SET t.<col> = s.<col>
WHEN NOT MATCHED THEN
  INSERT (<col>) VALUES (<col>);
```

---

## Data Definition (DDL)

### `fbcreatetable` — CREATE TABLE

```sql
CREATE TABLE <name> (
  <id_column> INTEGER NOT NULL,
  <col>        VARCHAR(255),
  CONSTRAINT PK_<name> PRIMARY KEY (<id_column>)
);
```

### `fbcreatetablegen` — CREATE TABLE with Auto-Increment

Creates a table, a generator (sequence), and a `BEFORE INSERT` trigger that auto-populates the primary key:

```sql
CREATE TABLE <name> (
  <id> INTEGER NOT NULL,
  <col> VARCHAR(255),
  CONSTRAINT PK_<name> PRIMARY KEY (<id>)
);

CREATE GENERATOR GEN_<name>_<id>;

SET TERM ^ ;
CREATE TRIGGER <name>_BI FOR <name>
ACTIVE BEFORE INSERT POSITION 0
AS
BEGIN
  IF (NEW.<id> IS NULL) THEN
    NEW.<id> = GEN_ID(GEN_<name>_<id>, 1);
END^
SET TERM ; ^
```

### `fbcreateview` — CREATE VIEW

```sql
CREATE VIEW <name> (<columns>)
AS
SELECT <columns>
FROM <table>
WHERE <condition>;
```

### `fbalterview` — CREATE OR ALTER VIEW

Same structure as above, using `CREATE OR ALTER` so it can be run repeatedly.

### `fbcreateproc` — CREATE PROCEDURE

```sql
SET TERM ^ ;
CREATE PROCEDURE <name> (<in_param> <type>)
RETURNS (<out_param> <type>)
AS
<declare block>
BEGIN
  <body>
  SUSPEND;
END^
SET TERM ; ^
```

### `fbalterproc` — CREATE OR ALTER PROCEDURE

Same structure, using `CREATE OR ALTER`.

### `fbcreatetrigbi` — CREATE TRIGGER BEFORE INSERT

```sql
SET TERM ^ ;
CREATE TRIGGER <name> FOR <table>
ACTIVE BEFORE INSERT POSITION 0
AS
BEGIN
  <body>
END^
SET TERM ; ^
```

### `fbcreatetrigbu` — CREATE TRIGGER BEFORE UPDATE

Same structure with `BEFORE UPDATE`.

### `fbcreatetrigai` — CREATE TRIGGER AFTER INSERT

Same structure with `AFTER INSERT`.

### `fbcreategenerator` — CREATE GENERATOR / SEQUENCE

```sql
CREATE GENERATOR <name>;
SET GENERATOR <name> TO <initial_value>;
```

### `fbcreatedomain` — CREATE DOMAIN

```sql
CREATE DOMAIN <name> AS VARCHAR(255)
  DEFAULT <value>
  NOT NULL
  CHECK (<constraint>);
```

### `fbcreateexception` — CREATE EXCEPTION

```sql
CREATE EXCEPTION <name> '<message>';
```

### `fbcreateindex` — CREATE INDEX

```sql
CREATE UNIQUE INDEX <name>
ON <table> (<columns>);
```

Index type choices: `INDEX`, `UNIQUE INDEX`, `UNIQUE ASCENDING INDEX`, `UNIQUE DESCENDING INDEX`, `ASCENDING INDEX`, `DESCENDING INDEX`.

### `fbaltertableadd` — ALTER TABLE ADD COLUMN

```sql
ALTER TABLE <table>
ADD <column> VARCHAR(255);
```

### `fbaltertablefk` — ALTER TABLE ADD FOREIGN KEY

```sql
ALTER TABLE <table>
ADD CONSTRAINT FK_<table>_<ref_table>
FOREIGN KEY (<column>)
REFERENCES <ref_table> (<ref_column>);
```

---

## PSQL Blocks and Control Flow

### `fbexecblock` — EXECUTE BLOCK

```sql
EXECUTE BLOCK
AS
  DECLARE VARIABLE <var> <type>;
BEGIN
  <body>
END
```

### `fbexecblockparams` — EXECUTE BLOCK with Parameters

```sql
EXECUTE BLOCK (<in_param> <type> = :<binding>)
RETURNS (<out_param> <type>)
AS
  DECLARE VARIABLE <var> <type>;
BEGIN
  <body>
  SUSPEND;
END
```

### `fbif` — IF THEN ELSE

```sql
IF (<condition>) THEN
BEGIN
  <true_branch>
END
ELSE
BEGIN
  <false_branch>
END
```

### `fbwhile` — WHILE DO

```sql
WHILE (<condition>) DO
BEGIN
  <body>
END
```

### `fbforselect` — FOR SELECT DO

```sql
FOR SELECT <columns>
  FROM <table>
  WHERE <condition>
  INTO <variables>
DO
BEGIN
  <body>
  SUSPEND;
END
```

### `fbbegin` — BEGIN END Block

```sql
BEGIN
  
END
```

### `fbdeclare` — DECLARE VARIABLE

```sql
DECLARE VARIABLE <name> INTEGER;
```

Type choices: `INTEGER`, `BIGINT`, `SMALLINT`, `VARCHAR(255)`, `CHAR(1)`, `FLOAT`, `DOUBLE PRECISION`, `DECIMAL(18,2)`, `DATE`, `TIME`, `TIMESTAMP`, `BLOB`.

### `fbwhenany` — WHEN ANY DO

```sql
WHEN ANY DO
BEGIN
  <handler>
END
```

### `fbwhenexception` — WHEN EXCEPTION DO

```sql
WHEN EXCEPTION <exception_name> DO
BEGIN
  <handler>
END
```

### `fbautonomous` — IN AUTONOMOUS TRANSACTION

```sql
IN AUTONOMOUS TRANSACTION DO
BEGIN
  <body>
END
```

### `fbexecproc` — EXECUTE PROCEDURE

```sql
EXECUTE PROCEDURE <name>(<args>);
```

---

## Advanced Queries

### `fbwith` — WITH CTE (Common Table Expression)

```sql
WITH <cte_name> AS (
  SELECT <columns>
  FROM <table>
  WHERE <condition>
)
SELECT <columns>
FROM <cte_name>;
```

### `fbwithrecursive` — WITH RECURSIVE CTE

```sql
WITH RECURSIVE <cte_name> AS (
  SELECT <columns>
  FROM <anchor_table>
  WHERE <anchor_condition>
  UNION ALL
  SELECT <columns>
  FROM <recursive_table>
  JOIN <cte_name> ON <join_condition>
)
SELECT * FROM <cte_name>;
```

---

## Security

### `fbgrant` — GRANT Privileges

```sql
GRANT ALL ON <object> TO <user_or_role>;
```

Privilege choices: `ALL`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `EXECUTE`, `REFERENCES`.

### `fbrevoke` — REVOKE Privileges

```sql
REVOKE ALL ON <object> FROM <user_or_role>;
```

---

## Utility

### `fbsetterm` — SET TERM

```sql
SET TERM <new_terminator> ;
<body>
SET TERM ; <new_terminator>
```

---

## Expressions and Functions

### `fbcase` — CASE WHEN

```sql
CASE
  WHEN <condition1> THEN <result1>
  WHEN <condition2> THEN <result2>
  ELSE <default>
END
```

### `fbcoalesce` — COALESCE

```sql
COALESCE(<expr1>, <expr2>)
```

### `fbiif` — IIF (inline IF)

```sql
IIF(<condition>, <true_value>, <false_value>)
```

### `fbgenid` — GEN_ID

```sql
GEN_ID(<generator_name>, <increment>)
```

### `fbcast` — CAST

```sql
CAST(<expr> AS <type>)
```

### `fbextract` — EXTRACT

```sql
EXTRACT(YEAR FROM <date_expr>)
```

Part choices: `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`, `MILLISECOND`, `WEEK`, `WEEKDAY`, `YEARDAY`.

---

## Quick Reference Table

| Prefix | Description |
|---|---|
| `fbselect` | SELECT statement |
| `fbjoin` | SELECT with JOIN |
| `fbfirst` | SELECT FIRST SKIP (pagination) |
| `fbinsert` | INSERT INTO |
| `fbinsertret` | INSERT INTO … RETURNING |
| `fbupdate` | UPDATE SET |
| `fbdelete` | DELETE FROM |
| `fbmerge` | MERGE INTO (upsert) |
| `fbcreatetable` | CREATE TABLE |
| `fbcreatetablegen` | CREATE TABLE with auto-increment generator |
| `fbcreateview` | CREATE VIEW |
| `fbalterview` | CREATE OR ALTER VIEW |
| `fbcreateproc` | CREATE PROCEDURE |
| `fbalterproc` | CREATE OR ALTER PROCEDURE |
| `fbcreatetrigbi` | CREATE TRIGGER BEFORE INSERT |
| `fbcreatetrigbu` | CREATE TRIGGER BEFORE UPDATE |
| `fbcreatetrigai` | CREATE TRIGGER AFTER INSERT |
| `fbcreategenerator` | CREATE GENERATOR / SEQUENCE |
| `fbcreatedomain` | CREATE DOMAIN |
| `fbcreateexception` | CREATE EXCEPTION |
| `fbcreateindex` | CREATE INDEX |
| `fbaltertableadd` | ALTER TABLE ADD COLUMN |
| `fbaltertablefk` | ALTER TABLE ADD FOREIGN KEY |
| `fbexecblock` | EXECUTE BLOCK |
| `fbexecblockparams` | EXECUTE BLOCK with parameters |
| `fbif` | IF THEN ELSE |
| `fbwhile` | WHILE DO |
| `fbforselect` | FOR SELECT DO |
| `fbbegin` | BEGIN END block |
| `fbdeclare` | DECLARE VARIABLE |
| `fbwhenany` | WHEN ANY DO |
| `fbwhenexception` | WHEN EXCEPTION DO |
| `fbautonomous` | IN AUTONOMOUS TRANSACTION |
| `fbexecproc` | EXECUTE PROCEDURE |
| `fbwith` | WITH CTE |
| `fbwithrecursive` | WITH RECURSIVE CTE |
| `fbgrant` | GRANT privileges |
| `fbrevoke` | REVOKE privileges |
| `fbsetterm` | SET TERM |
| `fbcase` | CASE WHEN |
| `fbcoalesce` | COALESCE |
| `fbiif` | IIF (inline IF) |
| `fbgenid` | GEN_ID |
| `fbcast` | CAST |
| `fbextract` | EXTRACT |

---

## Further Reading

- [Getting Started Tutorial](getting-started.md)
- [Connection Setup](connection-setup.md)
- [Firebird Language Reference](https://firebirdsql.org/en/reference-manuals/)

import { Global } from '../shared/global';
import { getOptions } from '../config';
import { getTablesQuery, fieldsQuery } from '../shared/queries';
import { ConnectionOptions, Schema } from '../interfaces';
import { logger } from '../logger/logger';
import { Driver } from '../shared/driver';
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas, connectionSearchPath } from "../shared/schema-support";

type ResultSet = Array<any>;

/**
 * How long a built schema stays usable before it is rebuilt.
 *
 * There was no cache at all before this, which is worth stating plainly because both CLAUDE.md and
 * the roadmap referred to "the completion provider's schema cache" as though one existed. Measured
 * against a live server on a *ten-table* database, three consecutive completions opened three
 * connections and issued six catalogue queries — every keystroke that triggered completion paid a
 * fresh connection plus `getTablesQuery()` plus `fieldsQuery()`, the latter naming every table in
 * the database. The hover provider shares this handler, so hovering paid it too.
 *
 * Thirty seconds is a deliberate middle: long enough that typing never rebuilds, short enough that
 * a table created outside this extension appears without a restart. Anything done *through* the
 * extension does not wait for it — `invalidate()` is called when the tree is refreshed or the
 * active connection changes.
 */
export const SCHEMA_CACHE_TTL_MS = 30_000;

/**
 * What a cached schema is keyed by. Not the connection id alone: the default schema changes what
 * the catalogue queries return (Firebird 6 search path), and the three completion settings change
 * the shape of what is built, so a change to any of them must not be served a stale answer.
 * Exported for testing.
 */
export function schemaCacheKey(
    connection: Pick<ConnectionOptions, "id" | "defaultSchema">,
    options: { codeCompletionKeywords: boolean; codeCompletionDatabase: boolean; maxTablesCount: number }
): string {
    return [
        connection.id,
        connection.defaultSchema ?? "",
        options.codeCompletionKeywords ? "kw" : "-",
        options.codeCompletionDatabase ? "db" : "-",
        options.maxTablesCount,
    ].join("::");
}

export class KeywordsDb {
    private cached?: { key: string; builtAt: number; schema: Schema.Database };

    /** Drops the cached schema so the next completion rebuilds it. */
    public invalidate(): void {
        this.cached = undefined;
    }

    public async getSchema(now: number = Date.now()): Promise<Schema.Database> {
        try {
            // No active connection means there's nothing to query regardless of the
            // codeCompletionDatabase setting — without this check, build() below would be called
            // with conOptions === undefined and throw on conOptions.database.
            if (!Global.activeConnection || !getOptions().codeCompletionDatabase) {
                return { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
            }
            const options = getOptions();
            const key = schemaCacheKey(Global.activeConnection, options);
            if (this.cached && this.cached.key === key && now - this.cached.builtAt < SCHEMA_CACHE_TTL_MS) {
                return this.cached.schema;
            }
            const schema = await this.build(Global.activeConnection, options.codeCompletionKeywords, options.maxTablesCount);
            const resolved = schema ?? { reservedKeywords: options.codeCompletionKeywords, path: "", tables: [] };
            // A database with no tables caches too: build() returns undefined for that, and
            // re-asking the server every keystroke to be told "still nothing" is the same waste.
            this.cached = { key, builtAt: now, schema: resolved };
            return resolved;
        } catch (err) {
            logger.error(err);
            return { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
        }
    }

    async build(conOptions: ConnectionOptions, codeCompletionKeywords: boolean, maxTablesCount: number): Promise<Schema.Database | undefined> {
        const schema = {
            reservedKeywords: codeCompletionKeywords,
            path: conOptions.database,
            tables: [],
        } as Schema.Database;
        const tableNames: string[] = [];

        const connection = await Driver.client.createConnection(await Driver.resolvePassword(conOptions));
        try {
            return await this.buildFrom(connection, conOptions, schema, tableNames, maxTablesCount);
        } finally {
            // Every other path through Driver detaches in a finally; this one never did, so each
            // completion leaked a connection — three completions, three attachments, measured.
            // With pooling on, detach() is what returns it to the pool rather than closing it.
            await Driver.client.detach(connection).catch(() => { /* already gone */ });
        }
    }

    private async buildFrom(
        connection: any, conOptions: ConnectionOptions, schema: Schema.Database, tableNames: string[],
        maxTablesCount: number
    ): Promise<Schema.Database | undefined> {
        // Firebird 6 keeps every object in a schema. Without asking, two same-named tables from
        // different schemas produce two identical completion entries and there is no way to tell
        // which is which — or to insert the one you meant.
        const withSchemas = supportsSchemas(
            await getEngineMajorVersion(conOptions.id, (sql: string) => Driver.client.queryPromise<any>(connection, sql))
        );
        // What this connection's sessions actually attach with, so completion can rank a table
        // reachable without qualification above one that is not. Only meaningful on Firebird 6.
        if (withSchemas) {
            const searchPath = connectionSearchPath(conOptions.defaultSchema);
            if (searchPath.length) {
                schema.searchPath = searchPath;
            }
        }

        const resultSet: ResultSet = await Driver.client.queryPromise(connection, getTablesQuery(maxTablesCount, withSchemas));
        if (!resultSet || resultSet.length === 0) {
            return undefined;
        }

        schema.tables = resultSet.map((row: any) => {
            tableNames.push(row.TABLE_NAME.trim());
            return {
                name: row.TABLE_NAME.trim(),
                schema: withSchemas ? String(row.SCHEMA_NAME ?? "").trim() || undefined : undefined,
                fields: [],
            } as Schema.Table;
        });

        const fieldsResult: ResultSetFields[] = await Driver.client.queryPromise(connection, fieldsQuery(tableNames, withSchemas));
        if (!fieldsResult || fieldsResult.length === 0) {
            return undefined;
        }

        // Keyed by schema + name, so two same-named tables do not pool each other's columns.
        const key = (schemaName: unknown, tableName: unknown) =>
            `${withSchemas ? String(schemaName ?? "").trim() : ""}.${String(tableName ?? "").trim()}`;
        const groupedResult: { [key: string]: ResultSetFields[] } = {};
        fieldsResult.forEach((table: any) => {
            const k = key(table.SCHEMA_NAME, table.TBL);
            groupedResult[k] = [...(groupedResult[k] ?? []), table];
        });

        for (const schemaTable of schema.tables) {
            (groupedResult[key(schemaTable.schema, schemaTable.name)] ?? []).forEach(element => {
                let field_type = element.FIELD_TYPE.trim();
                if (field_type === 'VARCHAR') field_type = `${field_type}(${element.FIELD_LENGTH})`;
                schemaTable.fields.push({
                    name: element.FIELD.trim(),
                    type: field_type,
                } as Schema.Field);
            });
        }
        return schema;

    }
}

interface ResultSetFields {
    DFLT_VALUE: any;
    FIELD: string;
    FIELD_LENGTH: number;
    FIELD_TYPE: string;
    NOTNULL: string;
    POS: number;
    TBL: string;
}
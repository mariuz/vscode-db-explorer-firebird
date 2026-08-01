import { Global } from '../shared/global';
import { getOptions } from '../config';
import { getTablesQuery, fieldsQuery } from '../shared/queries';
import { ConnectionOptions, Schema } from '../interfaces';
import { logger } from '../logger/logger';
import { Driver } from '../shared/driver';
import { getEngineMajorVersion } from "../shared/engine-version";
import { supportsSchemas } from "../shared/schema-support";

type ResultSet = Array<any>;

export class KeywordsDb {
    public async getSchema(): Promise<Schema.Database> {
        try {
            // No active connection means there's nothing to query regardless of the
            // codeCompletionDatabase setting — without this check, build() below would be called
            // with conOptions === undefined and throw on conOptions.database.
            if (!Global.activeConnection || !getOptions().codeCompletionDatabase) {
                return { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
            }
            const schema = await this.build(Global.activeConnection, getOptions().codeCompletionKeywords, getOptions().maxTablesCount);
            return schema ?? { reservedKeywords: getOptions().codeCompletionKeywords, path: "", tables: [] };
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
        // Firebird 6 keeps every object in a schema. Without asking, two same-named tables from
        // different schemas produce two identical completion entries and there is no way to tell
        // which is which — or to insert the one you meant.
        const withSchemas = supportsSchemas(
            await getEngineMajorVersion(conOptions.id, (sql: string) => Driver.client.queryPromise<any>(connection, sql))
        );
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
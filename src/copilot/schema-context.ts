import { Schema } from '../interfaces';

/**
 * Builds a concise schema description suitable for inclusion as LLM context.
 *
 * The output is a compact DDL-style listing of tables and their columns
 * that gives the model enough information to write correct SQL against
 * the active Firebird database.
 *
 * @param schema The database schema obtained from {@link KeywordsDb.getSchema}.
 * @returns A multi-line string describing the schema, or an empty string when
 *          no schema / tables are available.
 */
export function buildSchemaContext(schema: Schema.Database | undefined): string {
    if (!schema || !schema.tables || schema.tables.length === 0) {
        return '';
    }

    const lines: string[] = [];
    for (const table of schema.tables) {
        const cols = table.fields
            .map(f => `${f.name}${f.type ? ' ' + f.type : ''}`)
            .join(', ');
        lines.push(`${table.name}(${cols})`);
    }
    return lines.join('\n');
}

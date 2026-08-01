/**
 * Code completion schema for table and field names
 */
export type FirebirdSchema = Schema.Database;

export namespace Schema {
  export interface Database {
    reservedKeywords: boolean;
    path: string;
    tables: Schema.Table[];
  }

  export interface Table {
    /** Bare relation name. Stays bare so every existing consumer keeps matching on it. */
    name: string;
    /** Firebird 6+ only: the owning schema, used to disambiguate two same-named tables. */
    schema?: string;
    fields: Schema.Field[];
  }

  export interface Field {
    name: string;
    type?: string;
  }
}

/**
 * F12 on a table name opens its generated `CREATE TABLE` DDL — see definition-model.ts for the
 * URI scheme and docs/roadmap/sql-language-features.md for why the definition is generated rather
 * than located.
 */

import {
  CancellationToken, Definition, DefinitionProvider as VSDefinitionProvider, Location, Position,
  TextDocument, TextDocumentContentProvider, Uri,
} from "vscode";
import { FirebirdSchema } from "../interfaces";
import { Driver } from "../shared/driver";
import { Global } from "../shared/global";
import { tableInfoQuery } from "../shared/queries";
import { tableInfoRowsToTable } from "../script-as/ddl-builders";
import { buildTableCreateDDL } from "../database-projects/project-model";
import { identifierAt } from "./hover-model";
import { DDL_SCHEME, ddlDocumentPath, findTableName, objectNameFromDdlPath } from "./definition-model";

export class SqlDefinitionProvider implements VSDefinitionProvider {
  constructor(private readonly schemaProvider: { provideSchema: (doc: TextDocument) => Thenable<FirebirdSchema> }) {}

  public async provideDefinition(document: TextDocument, position: Position): Promise<Definition | undefined> {
    const identifier = identifierAt(document.lineAt(position.line).text, position.character);
    if (!identifier) {
      return undefined;
    }

    // Same failure policy as hover: no connection, or a lookup that throws, means no definition
    // rather than an error dialog on a keypress.
    let schema;
    try {
      schema = await this.schemaProvider.provideSchema(document);
    } catch {
      return undefined;
    }

    const tableName = findTableName(identifier, schema as any);
    if (!tableName) {
      return undefined;
    }

    return new Location(Uri.parse(`${DDL_SCHEME}:${ddlDocumentPath(tableName)}`), new Position(0, 0));
  }
}

/**
 * Generates the DDL a definition URI points at.
 *
 * Content is produced on demand and VS Code caches it per URI, so repeatedly pressing F12 on the
 * same table reuses one editor rather than opening a new untitled document each time — the
 * behaviour the design doc called out as needing a decision.
 */
export class DdlDocumentProvider implements TextDocumentContentProvider {
  public async provideTextDocumentContent(uri: Uri, _token: CancellationToken): Promise<string> {
    const objectName = objectNameFromDdlPath(uri.path);
    const connection = Global.activeConnection;
    if (!connection) {
      return `-- No active Firebird connection, so ${objectName} cannot be scripted.`;
    }

    try {
      const rows = await Driver.runQuery(tableInfoQuery(objectName), connection);
      if (!rows || rows.length === 0) {
        return `-- ${objectName} has no columns, or no longer exists.`;
      }
      return [
        `-- Generated from the connected database. Read-only; edit the table through the`,
        `-- Object Explorer or a DDL statement of your own.`,
        "",
        buildTableCreateDDL(tableInfoRowsToTable(objectName, rows)),
      ].join("\n");
    } catch (err: any) {
      return `-- Could not script ${objectName}: ${err?.message ?? err}`;
    }
  }
}

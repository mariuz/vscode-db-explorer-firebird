import * as vscode from 'vscode';
import { Schema } from '../interfaces';

/**
 * SQL linter for Firebird SQL documents.
 * Registers a DiagnosticCollection and re-lints on document change/open.
 */
export class SqlLinter implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private subscriptions: vscode.Disposable[] = [];
  private schemaProvider?: () => Promise<Schema.Database>;

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('firebird-sql');
  }

  /** Provide a schema provider so the linter can validate table/column names */
  setSchemaProvider(provider: () => Promise<Schema.Database>): void {
    this.schemaProvider = provider;
  }

  /** Start listening to document events */
  activate(context: vscode.ExtensionContext): void {
    // Lint on open
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (this.isSqlDoc(doc)) {
          this.lintDocument(doc);
        }
      })
    );

    // Lint on change (with a short debounce)
    let debounceTimer: NodeJS.Timeout | undefined;
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.isSqlDoc(event.document)) {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(() => {
            this.lintDocument(event.document);
          }, 500);
        }
      })
    );

    // Clear diagnostics when document is closed
    this.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.diagnosticCollection.delete(doc.uri);
      })
    );

    // Lint any already-open SQL documents
    for (const doc of vscode.workspace.textDocuments) {
      if (this.isSqlDoc(doc)) {
        this.lintDocument(doc);
      }
    }

    context.subscriptions.push(this.diagnosticCollection);
  }

  /** Run all lint rules against a document and update diagnostics */
  async lintDocument(document: vscode.TextDocument): Promise<void> {
    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    const rules = this.gatherDiagnostics(text, document);
    diagnostics.push(...rules);

    // Schema-aware rules (table name validation)
    if (this.schemaProvider) {
      const schemaDiags = await this.lintAgainstSchema(text, document);
      diagnostics.push(...schemaDiags);
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  /** Clear all diagnostics */
  clearAll(): void {
    this.diagnosticCollection.clear();
  }

  // ─── Lint Rules ────────────────────────────────────────────────────────────

  private gatherDiagnostics(text: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];

    diags.push(...this.checkSelectStar(text, doc));
    diags.push(...this.checkMissingWhereOnDelete(text, doc));
    diags.push(...this.checkMissingWhereOnUpdate(text, doc));
    diags.push(...this.checkMissingSemicolon(text, doc));

    return diags;
  }

  /** Warn about SELECT * usage */
  private checkSelectStar(text: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    const pattern = /\bSELECT\s+\*/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = doc.positionAt(match.index);
      const end = doc.positionAt(match.index + match[0].length);
      const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        'Avoid SELECT *: explicitly list the columns you need.',
        vscode.DiagnosticSeverity.Warning
      );
      diag.code = 'FBSQL001';
      diag.source = 'Firebird SQL Linter';
      diags.push(diag);
    }
    return diags;
  }

  /** Warn about DELETE without WHERE */
  private checkMissingWhereOnDelete(text: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    // Match DELETE FROM <table> that is not followed by WHERE before end of statement
    const stmtPattern = /\bDELETE\s+FROM\s+\S+([^;]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = stmtPattern.exec(text)) !== null) {
      const body = match[1];
      if (!/\bWHERE\b/i.test(body)) {
        const start = doc.positionAt(match.index);
        const end = doc.positionAt(match.index + match[0].length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'DELETE without WHERE clause will remove all rows.',
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = 'FBSQL002';
        diag.source = 'Firebird SQL Linter';
        diags.push(diag);
      }
    }
    return diags;
  }

  /** Warn about UPDATE without WHERE */
  private checkMissingWhereOnUpdate(text: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    const stmtPattern = /\bUPDATE\s+\S+\s+SET\s+([^;]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = stmtPattern.exec(text)) !== null) {
      const body = match[1];
      if (!/\bWHERE\b/i.test(body)) {
        const start = doc.positionAt(match.index);
        const end = doc.positionAt(match.index + match[0].length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'UPDATE without WHERE clause will update all rows.',
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = 'FBSQL003';
        diag.source = 'Firebird SQL Linter';
        diags.push(diag);
      }
    }
    return diags;
  }

  /** Hint about missing semicolons at the end of statements */
  private checkMissingSemicolon(text: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
    const diags: vscode.Diagnostic[] = [];
    // Simplified: check if DML/DDL statement blocks exist without trailing semicolon
    const stmtPattern = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b[\s\S]*?(?=\n\s*\n|\n\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = stmtPattern.exec(text)) !== null) {
      const stmt = match[0].trimEnd();
      if (stmt && !stmt.endsWith(';')) {
        const end = doc.positionAt(match.index + match[0].trimEnd().length);
        const start = doc.positionAt(match.index + match[0].trimEnd().length - 1);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'Statement may be missing a terminating semicolon.',
          vscode.DiagnosticSeverity.Hint
        );
        diag.code = 'FBSQL004';
        diag.source = 'Firebird SQL Linter';
        diags.push(diag);
      }
    }
    return diags;
  }

  /** Schema-aware: check that tables referenced in FROM/JOIN exist in the active schema */
  private async lintAgainstSchema(text: string, doc: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const diags: vscode.Diagnostic[] = [];
    let schema: Schema.Database;
    try {
      schema = await this.schemaProvider();
    } catch {
      return diags;
    }

    if (!schema || !schema.tables || schema.tables.length === 0) {
      return diags;
    }

    const knownTables = new Set(schema.tables.map(t => t.name.toUpperCase()));

    // Find all table references in FROM and JOIN clauses
    const fromPattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_$]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = fromPattern.exec(text)) !== null) {
      const tableName = match[1].toUpperCase();
      // Skip subquery indicators and known system tables
      if (tableName === 'RDB$' || tableName.startsWith('RDB$')) {
        continue;
      }
      if (!knownTables.has(tableName)) {
        const tableStart = match.index + match[0].length - match[1].length;
        const start = doc.positionAt(tableStart);
        const end = doc.positionAt(tableStart + match[1].length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Table '${match[1]}' not found in active database schema.`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.code = 'FBSQL005';
        diag.source = 'Firebird SQL Linter';
        diags.push(diag);
      }
    }
    return diags;
  }

  private isSqlDoc(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'sql';
  }

  dispose(): void {
    this.diagnosticCollection.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
    this.subscriptions = [];
  }
}

import * as assert from "assert";
import * as vscode from "vscode";

/**
 * The unit tier can prove formatSQL() produces the right text, but not that VS Code will ever call
 * it: a document selector that does not match, or a provider that was never registered, is silent.
 * Nothing throws, `Shift+Alt+F` simply does nothing -- which is exactly the state this feature was
 * in before. Only a real Extension Development Host can tell those apart, so these drive VS Code's
 * own `executeFormatDocumentProvider` / `executeFormatRangeProvider` commands rather than the
 * provider class.
 */
suite("SQL formatting provider (extension host)", function () {
  this.timeout(20000);

  async function openSql(content: string): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument({ language: "sql", content });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }

  function applied(doc: vscode.TextDocument, edits: vscode.TextEdit[] | undefined): string {
    const text = doc.getText();
    if (!edits || edits.length === 0) {
      return text;
    }
    // One provider, one edit in practice; apply in reverse offset order regardless.
    const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
    let out = text;
    for (const edit of sorted) {
      out = out.slice(0, doc.offsetAt(edit.range.start)) + edit.newText + out.slice(doc.offsetAt(edit.range.end));
    }
    return out;
  }

  test("VS Code finds a document formatter for a .sql document at all", async function () {
    const doc = await openSql("select a from t");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider", doc.uri, { tabSize: 4, insertSpaces: true }
    );
    assert.ok(edits, "no formatting provider answered — Shift+Alt+F would do nothing");
    assert.ok(edits.length > 0, "provider answered with no edits for unformatted SQL");
  });

  test("formatting a whole document uppercases keywords and lays out clauses", async function () {
    const doc = await openSql("select a, b from t where a = 1");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider", doc.uri, { tabSize: 4, insertSpaces: true }
    );
    const out = applied(doc, edits);
    assert.ok(out.startsWith("SELECT"), out);
    assert.ok(/\nFROM\b/.test(out), out);
    assert.ok(/\nWHERE\b/.test(out), out);
  });

  test("the editor's own indentation reaches the formatter", async function () {
    const doc = await openSql("select a, b from t");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider", doc.uri, { tabSize: 2, insertSpaces: true }
    );
    const out = applied(doc, edits);
    assert.ok(out.includes("\n  a,"), `expected a two-space indent: ${JSON.stringify(out)}`);
  });

  test("Format Selection works too — the range provider is registered, not just the document one", async function () {
    const doc = await openSql("-- leading comment\nselect a, b from t\n");
    const range = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 18));
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatRangeProvider", doc.uri, range, { tabSize: 4, insertSpaces: true }
    );
    assert.ok(edits && edits.length > 0, "no range formatter answered — Format Selection would do nothing");
    const out = applied(doc, edits);
    assert.ok(out.startsWith("-- leading comment"), `the untouched line was rewritten: ${out}`);
    assert.ok(/\bSELECT\b/.test(out), out);
  });

  test("already-formatted SQL produces no edit, so format-on-save cannot dirty a clean file", async function () {
    const doc = await openSql("SELECT *\nFROM T");
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider", doc.uri, { tabSize: 4, insertSpaces: true }
    );
    assert.strictEqual(edits?.length ?? 0, 0, `expected no edits, got ${JSON.stringify(edits)}`);
  });

  test("the keywordCase setting is contributed with the three values the provider accepts", function () {
    const extension = vscode.extensions.getExtension("AdrianMariusPopa.vscode-firebird-studio");
    assert.ok(extension, "extension should be found by id");
    const prop = extension!.packageJSON.contributes.configuration.properties["firebird.format.keywordCase"];
    assert.ok(prop, "firebird.format.keywordCase is not contributed");
    assert.deepStrictEqual(prop.enum, ["upper", "lower", "preserve"]);
    assert.strictEqual(prop.default, "upper");
  });
});

/**
 * Move to Schema is contributed to two menus as well as the palette, and a `when` clause that
 * never matches is silent — the item simply does not appear. Only a real host can read back what
 * the manifest actually declares.
 */
suite("Database Projects – Move to Schema contribution (extension host)", function () {
  this.timeout(20000);

  function manifest(): any {
    const extension = vscode.extensions.getExtension("AdrianMariusPopa.vscode-firebird-studio");
    assert.ok(extension, "extension should be found by id");
    return extension!.packageJSON;
  }

  test("the command is registered, not just declared", async function () {
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes("firebird.project.moveToSchema"));
  });

  test("it is reachable from the Explorer and the editor, gated on a .sql file", function () {
    const menus = manifest().contributes.menus;
    for (const menu of ["explorer/context", "editor/context"]) {
      const entry = (menus[menu] ?? []).find((m: any) => m.command === "firebird.project.moveToSchema");
      assert.ok(entry, `no ${menu} entry`);
      assert.strictEqual(entry.when, "resourceExtname == .sql", `${menu} when clause`);
    }
  });

  test("every menu entry names a command the manifest also declares", function () {
    // A menu entry pointing at an undeclared command renders as a blank item.
    const pkg = manifest();
    const declared = new Set(pkg.contributes.commands.map((c: any) => c.command));
    for (const [menu, entries] of Object.entries(pkg.contributes.menus as Record<string, any[]>)) {
      for (const entry of entries) {
        if (entry.command) {
          assert.ok(declared.has(entry.command), `${menu} names undeclared command ${entry.command}`);
        }
      }
    }
  });
});

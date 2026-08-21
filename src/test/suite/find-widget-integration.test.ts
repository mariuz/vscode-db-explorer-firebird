import * as assert from "assert";
import * as vscode from "vscode";
import { RESULTS_PANEL_OPTIONS } from "../../result-view/queryResultsView";

/**
 * `enableFindWidget` is declarative, so its failure mode is not a crash -- it is being silently
 * ignored, leaving Ctrl+F doing nothing exactly as before. TypeScript already catches a misspelled
 * property (it is typed on WebviewPanelOptions), so what is left to check is the half TypeScript
 * cannot see: that the VS Code actually running still accepts and reports the flag.
 */
suite("Webview find widget (extension host)", function () {
  this.timeout(20000);

  test("the results panels ask for the find widget", function () {
    assert.strictEqual(RESULTS_PANEL_OPTIONS.enableFindWidget, true);
  });

  test("this VS Code honours the flag rather than dropping it", function () {
    const panel = vscode.window.createWebviewPanel(
      "firebirdFindWidgetProbe", "probe", vscode.ViewColumn.One, { ...RESULTS_PANEL_OPTIONS }
    );
    try {
      assert.strictEqual(
        panel.options.enableFindWidget, true,
        "VS Code did not report the find widget as enabled — the option may have been renamed or removed"
      );
    } finally {
      panel.dispose();
    }
  });

  test("a panel that does not ask for it does not get it, so the flag is what makes the difference", function () {
    const panel = vscode.window.createWebviewPanel(
      "firebirdFindWidgetProbe2", "probe", vscode.ViewColumn.One, { enableScripts: true }
    );
    try {
      assert.notStrictEqual(panel.options.enableFindWidget, true);
    } finally {
      panel.dispose();
    }
  });
});

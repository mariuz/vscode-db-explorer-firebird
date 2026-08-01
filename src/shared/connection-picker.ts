import { QuickPickItem, window, ExtensionContext } from "vscode";
import { logger } from "../logger/logger";
import { ConnectionOptions } from "../interfaces";
import { Constants } from "../config/constants";
import { getConnectionLabel } from "./utils";

export async function connectionPicker(context: ExtensionContext): Promise<QuickPickItem | undefined> {
  logger.info("Choose Active Connection start...");

  return await getAvailableConnections(context).then(connections => {
    return showQuickPick(connections);
  });
}

async function getAvailableConnections(context: ExtensionContext): Promise<QuickPickItem[]> {
  /* fetch saved connections if any */
  let savedConnections = await context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey);

  if (!savedConnections) {
    savedConnections = {};
  }

  if (!Object.keys(savedConnections).length) {
    return Promise.reject(new Error("FIREBIRD: No saved connections found."));
  }

  return Object.keys(savedConnections).map(id => {
    const conn = savedConnections[id];
    return {
      label: getConnectionLabel(conn),
      detail: "connection id: " + id
    };
  });
}

async function showQuickPick(connections: QuickPickItem[]): Promise<QuickPickItem | undefined> {
  return await window.showQuickPick(connections, {
    placeHolder: "FIREBIRD: Choose Active Database"
  });
}

/**
 * Picks a saved connection and returns its `ConnectionOptions`, or undefined if the user
 * cancelled.
 *
 * Exists so commands that normally receive a tree node can still be run from the Command Palette.
 * Several of this extension's most useful commands — Set Connection Password, Visualize Schema,
 * Search Objects — take a `NodeDatabase` argument, which means invoking them from the palette
 * passes `undefined` and they fail; the only way to reach them is the tree's context menu.
 *
 * Returns the options rather than a `QuickPickItem` so callers do not have to parse the id back
 * out of a display string, which is what `firebird.chooseActive` does today.
 */
export async function pickConnectionOptions(context: ExtensionContext): Promise<ConnectionOptions | undefined> {
  const saved = context.globalState.get<{ [key: string]: ConnectionOptions }>(Constants.ConectionsKey) ?? {};
  const ids = Object.keys(saved);
  if (ids.length === 0) {
    logger.showError("No saved Firebird connections. Add one first.");
    return undefined;
  }

  const items = ids.map(id => ({ label: getConnectionLabel(saved[id]), id }));
  const picked = await window.showQuickPick(items, { placeHolder: "Select a Firebird connection" });
  if (!picked) {
    return undefined;
  }
  // The id is the globalState key, so it has to be put back on the options — several callers
  // (password storage, MCP exposure) key off it.
  return { ...saved[picked.id], id: picked.id };
}

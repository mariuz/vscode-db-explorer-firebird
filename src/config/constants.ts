const manifest = require("../../package.json");

export namespace Constants {
  /* extension */
  export const Id: string = manifest.name;
  export const DisplayName: string = manifest.displayName;
  export const Version: string = manifest.version;
  export const ConectionsKey: string = "firebird.connections";
  export const LastShownVersionKey: string = "firebird.lastShownVersion";
  export const RecentConnectionsKey: string = "firebird.recentConnections";

  /* output channel */
  export const OutputChannel: string = DisplayName;

  /* explorer */
  export const FirebirdExplorerViewId = manifest.contributes.views["firebird-tree"][0].id;
}

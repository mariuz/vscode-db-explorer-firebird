import { Disposable } from "vscode";
import { join } from "path";
import { QueryResultsView, Message } from "../result-view/queryResultsView";
import { ConnectionOptions } from "../interfaces";
import { Driver } from "../shared/driver";
import { logger } from "../logger/logger";

export class TableDesigner extends QueryResultsView implements Disposable {
  private dbDetails: ConnectionOptions | undefined;

  constructor(private readonly extensionPath: string) {
    super("tabledesigner", "Firebird Table Designer");
  }

  open(dbDetails?: ConnectionOptions) {
    this.dbDetails = dbDetails;
    super.show(join(this.extensionPath, "src", "table-designer", "htmlContent", "index.html"));
  }

  handleMessage(message: Message): void {
    const { command, data } = message as Message & { data: { ddl?: string } };
    if (command === "openInEditor") {
      Driver.createSQLTextDocument(data.ddl ?? "").catch(err => logger.error(err));
    } else if (command === "executeDDL") {
      if (!this.dbDetails) {
        this.send({ command: "result", data: { text: "No active database connection." } });
        return;
      }
      Driver.runQuery(data.ddl ?? "", this.dbDetails)
        .then(result => {
          const text = (result?.[0] as any)?.message ?? "DDL executed successfully.";
          this.send({ command: "result", data: { text } });
        })
        .catch(err => {
          const text = err?.message ?? String(err);
          logger.error(text);
          this.send({ command: "result", data: { text: `Error: ${text}` } });
        });
    }
  }
}

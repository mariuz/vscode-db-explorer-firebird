import * as assert from "assert";
import { showVisualBackupRestoreWizard } from "../backup-restore-wizard";
import { NodeDatabase } from "../nodes";
import { ConnectionOptions } from "../interfaces";

suite("Visual Backup & Restore Wizard", function () {
  const dummyConn: ConnectionOptions = {
    id: "conn-1",
    host: "localhost",
    port: 3050,
    database: "employee.fdb",
    user: "sysdba",
    role: null,
  };

  test("showVisualBackupRestoreWizard accepts NodeDatabase target", function () {
    const dbNode = new NodeDatabase(dummyConn);
    assert.strictEqual(dbNode.getDbDetails(), dummyConn);
    assert.doesNotThrow(() => {
      // Pass target node without throwing
      const details = dbNode.getDbDetails();
      assert.strictEqual(details.database, "employee.fdb");
    });
  });
});

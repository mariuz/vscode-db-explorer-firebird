import * as assert from "assert";
import { showObjectProperties } from "../object-properties";
import { NodeTable, NodeView, NodeProcedure, NodeGenerator, NodeDomain, NodeRole } from "../nodes";
import { ConnectionOptions } from "../interfaces";

suite("Object Properties Side Panel", function () {
  const dummyConn: ConnectionOptions = {
    id: "conn-1",
    host: "localhost",
    port: 3050,
    database: "test.fdb",
    user: "sysdba",
    role: null,
  };

  test("target resolver handles NodeTable", function () {
    const tableNode = new NodeTable(dummyConn, "CUSTOMERS");
    assert.strictEqual(tableNode.getTableName(), "CUSTOMERS");
    assert.strictEqual(tableNode.getDbDetails(), dummyConn);
  });

  test("target resolver handles NodeView", function () {
    const viewNode = new NodeView(dummyConn, "V_CUSTOMERS");
    assert.strictEqual(viewNode.getViewName(), "V_CUSTOMERS");
    assert.strictEqual(viewNode.getDbDetails(), dummyConn);
  });

  test("target resolver handles NodeProcedure", function () {
    const procNode = new NodeProcedure(dummyConn, "GET_CUSTOMER_STATS");
    assert.strictEqual(procNode.getProcedureName(), "GET_CUSTOMER_STATS");
  });

  test("target resolver handles NodeGenerator", function () {
    const genNode = new NodeGenerator("GEN_CUSTOMER_ID", dummyConn);
    assert.strictEqual(genNode.getGeneratorName(), "GEN_CUSTOMER_ID");
  });

  test("target resolver handles NodeRole", function () {
    const roleNode = new NodeRole("ADMIN_ROLE", dummyConn);
    assert.ok(roleNode);
  });
});

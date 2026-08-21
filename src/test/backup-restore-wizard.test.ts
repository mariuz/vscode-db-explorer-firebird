import * as assert from "assert";
import {
  buildWizardBackupArgs, buildWizardRestoreArgs, restoreTarget, GBAK_STATISTICS_SPEC
} from "../backup-restore-wizard";
import { renderGbakCommand } from "../shared/gbak-options";
import { ConnectionOptions } from "../interfaces";

/**
 * The wizard spawns gbak with an argument list it builds itself, which is the one part of this
 * feature that can fail silently and totally: a wrong switch means the operation does not happen,
 * and the only sign is gbak's own text in an output pane. Every flag asserted here was checked
 * against a real gbak 6.0 — both that it is accepted and, for the two that were wrong, that the
 * old spelling really did abort the run.
 */
suite("Visual Backup & Restore Wizard – gbak argument building", function () {
  const conn: ConnectionOptions = {
    id: "conn-1",
    host: "localhost",
    port: 3050,
    database: "/var/lib/firebird/employee.fdb",
    user: "sysdba",
    password: "masterkey",
    role: null,
  };

  suite("backup", function () {
    test("the bare minimum is a backup switch, the credentials, the source and the destination", function () {
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk" }, conn);
      assert.deepStrictEqual(args, [
        "-b",
        "-user", "sysdba", "-password", "masterkey",
        "localhost/3050:/var/lib/firebird/employee.fdb", "/tmp/out.fbk",
      ]);
    });

    // The regression this whole file exists for. A real gbak answers a bare `-st` with
    // `wrong char "-" at statistics parameter` and backs nothing up, because it reads the next
    // argument as the statistics spec. The checkbox is on by default, so this broke every backup
    // the wizard took until the value was supplied.
    test("Include statistics emits -st WITH its required value, never a bare -st", function () {
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk", includeStats: true }, conn);
      const st = args.indexOf("-st");
      assert.notStrictEqual(st, -1, "-st should be present");
      assert.strictEqual(args[st + 1], GBAK_STATISTICS_SPEC);
      assert.strictEqual(GBAK_STATISTICS_SPEC, "TDRW");
      assert.ok(!args[st + 1].startsWith("-"), `-st swallowed the next switch: ${args.join(" ")}`);
    });

    test("-st does not swallow the switch that follows it", function () {
      // The exact combination that failed: statistics, then another flag right behind it.
      const args = buildWizardBackupArgs(
        { backupPath: "/tmp/out.fbk", includeStats: true, skipGarbageCollection: true }, conn
      );
      assert.deepStrictEqual(args, [
        "-b", "-st", "TDRW", "-g",
        "-user", "sysdba", "-password", "masterkey",
        "localhost/3050:/var/lib/firebird/employee.fdb", "/tmp/out.fbk",
      ]);
    });

    test("every backup checkbox maps to a switch real gbak accepts", function () {
      const args = buildWizardBackupArgs({
        backupPath: "/tmp/out.fbk",
        transportable: true,
        metadataOnly: true,
        includeStats: true,
        skipGarbageCollection: true,
        ignoreChecksums: true,
      }, conn);
      // -T(RANSPORTABLE), -M(ETA_DATA), -ST(ATISTICS) TDRW, -G(ARBAGE_COLLECT), -IG(NORE).
      assert.deepStrictEqual(args.slice(0, 7), ["-b", "-t", "-m", "-st", "TDRW", "-g", "-ig"]);
    });

    test("no checkbox ticked emits no modifier flags at all, matching gbak's own defaults", function () {
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk" }, conn);
      assert.deepStrictEqual(args.filter(a => a.startsWith("-") && a !== "-b" && a !== "-user" && a !== "-password"), []);
    });

    test("a missing port falls back to Firebird's 3050 rather than emitting host/undefined", function () {
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk" }, { ...conn, port: undefined as any });
      assert.ok(args.includes("localhost/3050:/var/lib/firebird/employee.fdb"), args.join(" "));
    });

    test("with no connected node the user's typed target is used instead", function () {
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk", dbTarget: "remote-host/3050:/srv/db.fdb" }, undefined);
      assert.deepStrictEqual(args, ["-b", "remote-host/3050:/srv/db.fdb", "/tmp/out.fbk"]);
    });

    test("a connection with no stored password still produces a well-formed -password pair", function () {
      // gbak counts arguments positionally: dropping the value would make it read the source
      // database as the password and the destination as the source.
      const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk" }, { ...conn, password: undefined });
      const i = args.indexOf("-password");
      assert.strictEqual(args[i + 1], "");
      assert.deepStrictEqual(args, [
        "-b", "-user", "sysdba", "-password", "",
        "localhost/3050:/var/lib/firebird/employee.fdb", "/tmp/out.fbk",
      ]);
    });
  });

  suite("restore", function () {
    test("creates by default and replaces only when asked", function () {
      assert.strictEqual(buildWizardRestoreArgs({ restorePath: "/tmp/in.fbk" }, conn)[0], "-c");
      assert.strictEqual(
        buildWizardRestoreArgs({ restorePath: "/tmp/in.fbk", replaceExisting: true }, conn)[0], "-rep"
      );
    });

    test("the backup file comes before the target database, in gbak's own argument order", function () {
      const args = buildWizardRestoreArgs({ restorePath: "/tmp/in.fbk" }, conn);
      assert.deepStrictEqual(args, [
        "-c",
        "-user", "sysdba", "-password", "masterkey",
        "/tmp/in.fbk", "localhost/3050:/var/lib/firebird/employee.fdb",
      ]);
    });

    // The second proven regression: gbak answers `-inhibit_triggers` with
    // `unknown switch "INHIBIT_TRIGGERS"`, prints its usage and creates no database at all.
    // gbak has no restore-time trigger switch to put in its place -- `-NODBTRIGGERS` is refused
    // on restore ("allowed only on backup") -- so nothing is silently substituted either.
    test("no restore argument is a switch gbak would reject", function () {
      const args = buildWizardRestoreArgs({
        restorePath: "/tmp/in.fbk",
        replaceExisting: true,
        oneAtATime: true,
        pageSize: 8192,
      }, conn);
      assert.ok(!args.some(a => /inhibit_triggers/i.test(a)), args.join(" "));
      assert.ok(!args.some(a => /nodbtriggers/i.test(a)), args.join(" "));
      assert.deepStrictEqual(args.slice(0, 4), ["-rep", "-one_at_a_time", "-page_size", "8192"]);
    });

    test("a page size arrives as a string value after its switch", function () {
      const args = buildWizardRestoreArgs({ restorePath: "/tmp/in.fbk", pageSize: "16384" }, conn);
      const i = args.indexOf("-page_size");
      assert.strictEqual(args[i + 1], "16384");
    });

    test("an unset page size emits neither the switch nor a stray value", function () {
      const args = buildWizardRestoreArgs({ restorePath: "/tmp/in.fbk", pageSize: 0 }, conn);
      assert.ok(!args.includes("-page_size"), args.join(" "));
    });
  });

  suite("restoreTarget()", function () {
    test("an explicitly typed target wins over the connected database", function () {
      assert.strictEqual(restoreTarget({ targetDb: "srv/3050:/new.fdb" }, conn), "srv/3050:/new.fdb");
    });

    test("falls back to the connected database when nothing was typed", function () {
      assert.strictEqual(restoreTarget({}, conn), "localhost/3050:/var/lib/firebird/employee.fdb");
    });

    test("is empty when there is neither -- which is what the handler refuses on", function () {
      assert.strictEqual(restoreTarget({}, undefined), "");
    });
  });

  test("the command logged for the user never contains their password", function () {
    // The wizard logs its invocation before running it; renderGbakCommand() is what redacts.
    const args = buildWizardBackupArgs({ backupPath: "/tmp/out.fbk" }, conn);
    const rendered = renderGbakCommand("gbak", args);
    assert.ok(!rendered.includes("masterkey"), rendered);
    assert.ok(rendered.includes("********"), rendered);
  });
});

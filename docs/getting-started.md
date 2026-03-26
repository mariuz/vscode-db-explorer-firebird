# Getting Started with DB Explorer for Firebird Databases

This tutorial walks you through installing the extension, connecting to a Firebird database, and running your first query — all without leaving VS Code.

## Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/) 1.32 or later
- A running [Firebird](https://firebirdsql.org/) server (version 2.5, 3.0, 4.0, or 5.0) **or** an embedded `.fdb`/`.gdb` database file

> **No Firebird server?** You can [download Firebird](https://firebirdsql.org/en/firebird-downloads/) and install it locally in minutes. The installer includes the sample `employee.fdb` database which is perfect for this tutorial.

---

## Step 1 — Install the Extension

1. Open VS Code.
2. Go to the **Extensions** view (`Ctrl+Shift+X`).
3. Search for **DB Explorer for Firebird Databases**.
4. Click **Install** and then **Reload** (or restart VS Code).

After restarting, a **Firebird flame icon** appears in the Activity Bar on the left.

---

## Step 2 — Open the DB Explorer View

Click the **Firebird icon** in the Activity Bar. The **DB Explorer** panel opens in the Side Bar.

---

## Step 3 — Add Your First Connection

1. Click the **+** (Add New Connection) icon in the DB Explorer title bar.
2. The Connection Wizard opens. Fill in the fields:

   | Field | Example value |
   |---|---|
   | Host | `localhost` |
   | Port | `3050` |
   | Database path | `/var/lib/firebird/3.0/data/employee.fdb` |
   | Username | `SYSDBA` |
   | Password | `masterkey` |
   | Role | *(leave blank for default)* |

3. Click **Connect** (or press `Enter`).

Your database now appears in the tree under its host entry.

> **Tip:** For a detailed walkthrough of every connection option (including the native driver and WireCrypt), see [Connection Setup](connection-setup.md).

---

## Step 4 — Explore the Database Structure

Expand the database node in the tree to reveal category folders:

- **Tables** — user-defined tables
- **Views** — stored views
- **Stored Procedures** — callable procedures
- **Triggers** — table triggers
- **Generators** — sequences / auto-increment sources
- **Domains** — reusable column type definitions

Expand any table to see its **columns** with their data types.

> **Tip:** Right-click any tree node to see available actions such as **Select All Records**, **Show Table Info**, or **New Query**.

---

## Step 5 — Set the Active Database

Before running a query you must tell the extension which database to use.

**Option A — right-click:**
1. Right-click the database node in the tree.
2. Choose **Set Active**.

**Option B — status bar:**
1. Click the **Firebird** indicator in the VS Code status bar (bottom-left).
2. Select the database from the list.

The active database name appears in the status bar.

---

## Step 6 — Run Your First Query

1. Create a new SQL file: right-click the database node and choose **New Query**, or press `Ctrl+N` and save the file with a `.sql` extension.
2. Type a simple query:

   ```sql
   SELECT FIRST 10 * FROM EMPLOYEE
   ```

3. Press `Ctrl+Alt+Q` or right-click the editor and choose **Run Firebird Query**.
4. Results appear in a new panel with pagination, sorting, and filtering controls.

---

## Step 7 — Export Results

Inside the results panel you can export data using the toolbar buttons:

| Format | Notes |
|---|---|
| **CSV** | Comma-separated, compatible with Excel / LibreOffice |
| **JSON** | Array of objects, one per row |
| **XLSX** | Native Excel format |
| **PDF** | Print-friendly table layout |

---

## Next Steps

- **Use IntelliSense** — start typing a table or column name in a `.sql` file to get context-aware completions.
- **Use snippets** — type `fb` in a `.sql` file and press `Tab` to expand a code snippet. See the [SQL Snippets Reference](sql-snippets.md) for the full list.
- **Generate mock data** — right-click a table and choose **Generate Mock Data** (requires a [Mockaroo API key](https://www.mockaroo.com/)).
- **Customise settings** — open VS Code Settings (`Ctrl+,`) and search for `firebird` to adjust logging level, pagination, table count, and more.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Cannot connect | Check that the Firebird service is running and the port is reachable. Verify username / password. |
| `Error: invalid database` | Ensure the database path is correct and uses the right path separator for your OS. |
| Query returns no results | Confirm the active database is set and the table contains rows. |
| Extension logs | Open the Command Palette (`Ctrl+Shift+P`) → **Firebird: Show Extension Logs** |

---

## Further Reading

- [Connection Setup](connection-setup.md)
- [SQL Snippets Reference](sql-snippets.md)
- [Contributing Guide](../CONTRIBUTING.md)
- [Roadmap](../ROADMAP.md)

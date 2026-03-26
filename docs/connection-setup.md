# Connection Setup

This guide covers every option available in the DB Explorer for Firebird Databases connection wizard, including advanced settings such as the native driver and WireCrypt encryption.

## Opening the Connection Wizard

Click the **+** icon in the DB Explorer title bar, or run **Firebird: Add New Connection** from the Command Palette (`Ctrl+Shift+P`).

---

## Basic Connection Fields

| Field | Description | Default |
|---|---|---|
| **Host** | Hostname or IP address of the Firebird server | `localhost` |
| **Port** | TCP port the Firebird service listens on | `3050` |
| **Database** | Absolute path to the `.fdb` or `.gdb` file on the **server** | *(required)* |
| **Username** | Database username | `SYSDBA` |
| **Password** | Database password | *(required)* |
| **Role** | Optional user role to assume after login | *(blank)* |

> **Windows paths:** Use either forward slashes (`C:/data/mydb.fdb`) or escaped backslashes (`C:\\data\\mydb.fdb`).

---

## Connecting to Common Firebird Setups

### Local Firebird Server (default install)

```
Host:     localhost
Port:     3050
Database: /var/lib/firebird/3.0/data/employee.fdb   (Linux)
          C:/Program Files/Firebird/Firebird_3_0/examples/empbuild/EMPLOYEE.FDB  (Windows)
Username: SYSDBA
Password: masterkey
```

### Remote Firebird Server

```
Host:     192.168.1.100
Port:     3050
Database: /srv/firebird/production.fdb
Username: SYSDBA
Password: <your password>
```

### Embedded Database (`.fdb` file without a server)

When using the native driver (see below), you can connect directly to a `.fdb` file on disk without a running Firebird service:

```
Host:     (leave blank or use localhost)
Database: /home/user/myapp/data/app.fdb
Username: SYSDBA
Password: masterkey
```

---

## Native Driver (Experimental)

By default, the extension uses the pure-JavaScript `node-firebird` driver. An experimental **native driver** is also available, built on top of the official Firebird client library. It is required for:

- **WireCrypt** (wire encryption, available in Firebird 3+)
- Connecting to Firebird instances that enforce encrypted connections

### Enable the Native Driver

1. Open VS Code **Settings** (`Ctrl+,`).
2. Search for `firebird.useNativeDriver`.
3. Toggle it to **true**.

Or add this to your `settings.json`:

```json
{
  "firebird.useNativeDriver": true
}
```

### Install the Native Driver Binaries

The native driver requires the Firebird client library (`fbclient.dll` / `libfbclient.so`) to be installed on the machine running VS Code, **not** the server.

After enabling the setting, run the build command from the Command Palette:

**Firebird: Build Native Driver**

This compiles the native Node.js addon using `node-gyp`. Ensure you have a C++ build toolchain installed:

- **Linux:** `sudo apt install build-essential` (Debian/Ubuntu) or equivalent
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with "Desktop development with C++"

---

## Managing Connections

### Remove a Host

Right-click the host node in DB Explorer → **Remove Host**.  
This removes all databases registered under that host.

### Remove a Single Database

Right-click the database node → **Remove Database**.

### View Database Info

Right-click the database node → **Show Database Info** to see metadata such as the page size, ODS version, and dialect.

---

## Troubleshooting Connections

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connection refused` | Firebird service not running or wrong port | Start the service; check port in `firebird.conf` |
| `invalid database` | Path not found on the **server** filesystem | Use the path as seen by the server, not the client |
| `Wrong username or password` | Incorrect credentials | Verify in `gsec` or Firebird security database |
| `Your user name and password are not defined` | User does not exist | Create the user with `gsec -add <user>` |
| Native driver build fails | Missing build tools or Firebird client library | Install build tools and the Firebird client SDK |
| WireCrypt error | Native driver not enabled | Set `firebird.useNativeDriver: true` and rebuild |

### Viewing Connection Logs

Open the Command Palette (`Ctrl+Shift+P`) → **Firebird: Show Extension Logs**.

You can increase verbosity in Settings: set `firebird.logLevel` to `DEBUG`.

---

## Further Reading

- [Getting Started Tutorial](getting-started.md)
- [SQL Snippets Reference](sql-snippets.md)
- [Official Firebird Documentation](https://firebirdsql.org/en/documentation/)

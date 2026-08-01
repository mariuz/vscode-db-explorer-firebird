import { ExtensionContext } from "vscode";
import { logger } from "../logger/logger";

/**
 * Manages secure storage of Firebird connection passwords using VS Code's SecretStorage API.
 * Passwords are stored with the key prefix `firebird.password.<connectionId>` and are
 * never written to the unencrypted globalState.
 */
export class CredentialStore {
  private static _context: ExtensionContext;
  private static readonly KEY_PREFIX = "firebird.password.";
  private static readonly SSH_KEY_PREFIX = "firebird.sshPassword.";

  static setContext(context: ExtensionContext): void {
    this._context = context;
  }

  private static getContext(): ExtensionContext {
    if (!this._context) {
      throw new Error("CredentialStore: setContext() must be called before using SecretStorage.");
    }
    return this._context;
  }

  static async storePassword(connectionId: string, password: string): Promise<void> {
    await this.getContext().secrets.store(`${this.KEY_PREFIX}${connectionId}`, password);
    logger.debug(`Password stored for connection ${connectionId}`);
  }

  static async getPassword(connectionId: string): Promise<string | undefined> {
    return this.getContext().secrets.get(`${this.KEY_PREFIX}${connectionId}`);
  }

  static async deletePassword(connectionId: string): Promise<void> {
    await this.getContext().secrets.delete(`${this.KEY_PREFIX}${connectionId}`);
    logger.debug(`Password deleted for connection ${connectionId}`);
  }

  /**
   * Every connection id this store currently holds a secret for, database or SSH.
   *
   * The reason this exists: passwords are stored per connection id and deleted only when the
   * delete path runs. A connection removed while its delete failed, an id that changed shape
   * across versions, or a `globalState` entry lost some other way leaves a password in
   * SecretStorage permanently — with no way for the user *or* the extension to see it, let alone
   * clear it. `secrets.keys()` (VS Code 1.105) is what makes that auditable at all.
   */
  static async listStoredConnectionIds(): Promise<{ passwords: string[]; sshPasswords: string[] }> {
    const keys = await this.getContext().secrets.keys();
    return {
      passwords: keys.filter(k => k.startsWith(this.KEY_PREFIX)).map(k => k.slice(this.KEY_PREFIX.length)),
      sshPasswords: keys
        .filter(k => k.startsWith(this.SSH_KEY_PREFIX))
        .map(k => k.slice(this.SSH_KEY_PREFIX.length)),
    };
  }

  /**
   * Deletes every secret whose connection id is not in `liveConnectionIds`, returning how many
   * went. Takes the live ids rather than reading `globalState` itself so the caller owns the
   * definition of "still exists" — and so this stays testable without a workspace.
   */
  static async deleteOrphans(liveConnectionIds: Iterable<string>): Promise<number> {
    const live = new Set(liveConnectionIds);
    const { passwords, sshPasswords } = await this.listStoredConnectionIds();
    let removed = 0;
    for (const id of passwords) {
      if (!live.has(id)) {
        await this.deletePassword(id);
        removed++;
      }
    }
    for (const id of sshPasswords) {
      if (!live.has(id)) {
        await this.deleteSshPassword(id);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info(`Removed ${removed} stored password(s) belonging to connections that no longer exist.`);
    }
    return removed;
  }

  /** SSH tunnel password (authMethod "password") or private key passphrase (authMethod "privateKey") — same SecretStorage mechanism, a different key namespace so it's never confused with the database password. */
  static async storeSshPassword(connectionId: string, password: string): Promise<void> {
    await this.getContext().secrets.store(`${this.SSH_KEY_PREFIX}${connectionId}`, password);
    logger.debug(`SSH tunnel password stored for connection ${connectionId}`);
  }

  static async getSshPassword(connectionId: string): Promise<string | undefined> {
    return this.getContext().secrets.get(`${this.SSH_KEY_PREFIX}${connectionId}`);
  }

  static async deleteSshPassword(connectionId: string): Promise<void> {
    await this.getContext().secrets.delete(`${this.SSH_KEY_PREFIX}${connectionId}`);
    logger.debug(`SSH tunnel password deleted for connection ${connectionId}`);
  }
}

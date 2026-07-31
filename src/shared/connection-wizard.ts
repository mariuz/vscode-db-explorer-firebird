import { window, Disposable, ProgressLocation, QuickInput, QuickInputButtons, QuickPickItem } from "vscode";
import { probeDocker } from "./executable-probe";
import * as cp from "node:child_process";
import { ConnectionOptions } from "../interfaces";
import { logger } from "../logger/logger";
import { getOptions } from "../config";
import { parseConnectionString } from "./connection-string";
import { Driver } from "./driver";
import {
  DiscoveredFirebirdContainer,
  dockerPsArgs,
  dockerInspectEnvArgs,
  parseDockerPsOutput,
  parseDockerInspectEnv,
  discoverFirebirdContainers,
  suggestDatabasePath,
  resolveDockerExecutable,
} from "./docker-discovery";

type ConnectionType = "network" | "embedded" | "docker";

const checkDockerExecutable = (candidate: string): Promise<boolean> => probeDocker(candidate);

function execDocker(dockerExe: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile(dockerExe, args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

async function discoverRunningFirebirdContainers(): Promise<DiscoveredFirebirdContainer[]> {
  const dockerExe = await resolveDockerExecutable(getOptions().dockerPath || undefined, checkDockerExecutable);
  if (!dockerExe) {
    logger.info("Docker executable not found; skipping container discovery.");
    return [];
  }
  const stdout = await execDocker(dockerExe, dockerPsArgs());
  if (!stdout) { return []; }
  return discoverFirebirdContainers(parseDockerPsOutput(stdout));
}

async function suggestDatabasePathFor(dockerExe: string, containerId: string): Promise<string | undefined> {
  const stdout = await execDocker(dockerExe, dockerInspectEnvArgs(containerId));
  if (!stdout) { return undefined; }
  return suggestDatabasePath(parseDockerInspectEnv(stdout)["FIREBIRD_DATABASE"]);
}

/**
 * `existing`, when passed, puts the wizard in edit mode (docs/roadmap/connection-management-enhancements.md,
 * phase 3): every text field pre-fills from it (so leaving a step unchanged keeps the current
 * value), the "paste a connection string" prompt and the connection-type/Docker-discovery step are
 * both skipped (jumping straight to database()/host() depending on existing.embedded — changing a
 * connection's *type* isn't supported here, only its fields), and the terminal Test Connection step
 * is unchanged. Callers must pass `existing` with its password already resolved (e.g. via
 * NodeDatabase.getResolvedConnectionDetails()) for the password field to prefill correctly and for
 * an in-wizard connection test to work without the user having to retype an unchanged password.
 */
export async function connectionWizard(wizardTitle = "FIREBIRD: Add New Connection", existing?: ConnectionOptions) {
  const title = wizardTitle;

  async function collectInputs(): Promise<ConnectionOptions> {
    logger.info("Connection wizard start...");

    if (existing) {
      const options: Partial<ConnectionOptions> = { ...existing };
      await MultiStepInput.run(input =>
        existing.embedded ? database(input, options, 2, 5) : host(input, options)
      );
      return options as ConnectionOptions;
    }

    const pasted = await window.showInputBox({
      title,
      prompt: "Paste a Firebird connection string to prefill every field, or leave empty for the guided wizard below",
      placeHolder: "firebird://sysdba:masterkey@localhost:3050/employee",
      ignoreFocusOut: true,
    });
    if (pasted) {
      const parsed = parseConnectionString(pasted);
      if (parsed) {
        logger.info("Connection wizard: prefilled from a pasted connection string.");
        return {
          id: "",
          host: parsed.host ?? "",
          port: parsed.port ?? 3050,
          database: parsed.database ?? "",
          user: parsed.user ?? "sysdba",
          password: parsed.password ?? "masterkey",
          role: parsed.role ?? null,
          embedded: false,
          wireCrypt: parsed.wireCrypt,
        };
      }
      logger.showError("That doesn't look like a Firebird connection string (expected firebird://user:password@host:port/database) — continuing with the guided wizard.");
    }

    const options = {} as Partial<ConnectionOptions>;
    await MultiStepInput.run(input => connectionType(input, options));
    return options as ConnectionOptions;
  }

  async function connectionType(input: MultiStepInput, options: Partial<ConnectionOptions>) {
    const items: QuickPickItem[] = [
      { label: "$(server) Network", description: "Connect to a Firebird server via TCP/IP" },
      { label: "$(file-directory) Embedded", description: "Connect to a local embedded Firebird database file" },
      { label: "$(container) Docker", description: "Connect to a Firebird server running in Docker — auto-detects running containers" }
    ];

    const picked = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 8,
      items,
      placeholder: "Select connection type",
      ignoreFocusOut: true
    });

    if (!picked) {
      return Promise.reject("Connection type not selected. Add Connection canceled.");
    }

    const type: ConnectionType = picked.label.includes("Embedded")
      ? "embedded"
      : picked.label.includes("Docker")
      ? "docker"
      : "network";

    options.embedded = type === "embedded";

    if (type === "embedded") {
      options.host = "";
      options.port = null;
      return (input: MultiStepInput) => database(input, options, 2, 5);
    } else if (type === "docker") {
      return (input: MultiStepInput) => dockerContainer(input, options, 2, 8);
    } else {
      return (input: MultiStepInput) => host(input, options);
    }
  }

  async function dockerContainer(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const discovered = await discoverRunningFirebirdContainers();

    if (discovered.length === 0) {
      logger.info("No running Firebird Docker containers detected; defaulting to localhost:3050.");
      options.host = "localhost";
      options.port = 3050;
      return (input: MultiStepInput) => database(input, options, step + 1, totalSteps);
    }

    const manualEntry: QuickPickItem = { label: "$(edit) Enter manually", description: "localhost:3050 (default)" };
    const items: QuickPickItem[] = [
      ...discovered.map(d => ({
        label: `$(container) ${d.container.name}`,
        description: `${d.container.image} — localhost:${d.hostPort}`,
        detail: d.container.status
      })),
      manualEntry
    ];

    const picked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items,
      placeholder: "Select a running Firebird Docker container",
      ignoreFocusOut: true
    });

    if (!picked) {
      return Promise.reject("No container selected. Add Connection canceled.");
    }

    options.host = "localhost";

    if (picked === manualEntry) {
      options.port = 3050;
      return (input: MultiStepInput) => database(input, options, step + 1, totalSteps);
    }

    const match = discovered.find(d => picked.label === `$(container) ${d.container.name}`);
    options.port = match ? match.hostPort : 3050;

    let suggestedPath: string | undefined;
    if (match) {
      const dockerExe = await resolveDockerExecutable(getOptions().dockerPath || undefined, checkDockerExecutable);
      if (dockerExe) {
        suggestedPath = await suggestDatabasePathFor(dockerExe, match.container.id);
      }
    }

    return (input: MultiStepInput) => database(input, options, step + 1, totalSteps, suggestedPath);
  }

  async function host(input: MultiStepInput, options: Partial<ConnectionOptions>) {
    options.host = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 8,
      prompt: "[REQUIRED] The hostname of the database.",
      placeHolder: "e.g. 'localhost'",
      ignoreFocusOut: true,
      value: existing?.host
    });
    if (!options.host) {
      return Promise.reject("Hostname cannot be empty. Add Connection canceled.");
    } else {
      return (input: MultiStepInput) => database(input, options, 3, 8);
    }
  }

  async function database(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number,
    suggestedPath?: string
  ) {
    const prompt = options.embedded
      ? "[REQUIRED] Absolute path to the local Firebird database file."
      : "[REQUIRED] Absolute path to Firebird database on the server.";

    options.database = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt,
      placeHolder: "e.g. '/var/db/mydb.fdb'",
      ignoreFocusOut: true,
      value: suggestedPath ?? existing?.database
    });
    if (!options.database) {
      return Promise.reject("Database cannot be empty. Add Connection canceled.");
    } else if (options.embedded) {
      return (input: MultiStepInput) => user(input, options, step + 1, totalSteps);
    } else {
      return (input: MultiStepInput) => port(input, options, step + 1, totalSteps);
    }
  }

  async function port(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const portInput = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] Port number. Leave empty for default.",
      placeHolder: "defaults to 3050",
      ignoreFocusOut: true,
      value: existing?.port != null ? String(existing.port) : undefined
    });
    if (!portInput) {
      logger.info("Default port 3050 selected.");
      options.port = 3050;
    } else {
      options.port = Number.parseInt(portInput) || 3050;
    }
    return (input: MultiStepInput) => user(input, options, step + 1, totalSteps);
  }

  async function user(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.user = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] Firebird user to authenticate as. Leave empty for default.",
      placeHolder: "defaults to SYSDBA",
      ignoreFocusOut: true,
      value: existing?.user
    });
    if (!options.user) {
      logger.info("Default user sysdba selected.");
      options.user = "sysdba";
    }
    return (input: MultiStepInput) => password(input, options, step + 1, totalSteps);
  }

  async function password(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.password = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] The password of the Firebird user. Leave empty for default.",
      placeHolder: "defaults to masterkey",
      ignoreFocusOut: true,
      password: true,
      value: existing?.password
    });

    if (!options.password) {
      logger.info("Default password masterkey selected.");
      options.password = "masterkey";
    }
    return (input: MultiStepInput) => role(input, options, step + 1, totalSteps);
  }

  async function role(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    options.role = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] User Role. Leave empty for default.",
      placeHolder: "Defaults to null",
      ignoreFocusOut: true,
      value: existing?.role ?? undefined
    });

    if (!options.role) {
      logger.info("Default user role selected.");
      options.role = null;
    }

    if (!options.embedded) {
      return (input: MultiStepInput) => wireCrypt(input, options, step + 1, totalSteps);
    }
    return (input: MultiStepInput) => testConnection(input, options, step + 1, totalSteps);
  }

  async function wireCrypt(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const items: QuickPickItem[] = [
      { label: "Enabled", description: "Use wire encryption when available (default)" },
      { label: "Required", description: "Always require wire encryption (Firebird 4.x/5.x)" },
      { label: "Disabled", description: "Disable wire encryption" }
    ];

    const picked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items,
      placeholder: "[OPTIONAL] Wire encryption — Firebird 4.x/5.x (leave as Enabled for older versions)",
      ignoreFocusOut: true
    });

    if (picked) {
      // Enabled is the default, so it's cleared rather than stored explicitly -- but still an
      // explicit clear, not left alone, so editing an existing "Disabled" connection back to
      // "Enabled" actually takes effect rather than leaving the old value in place (see the
      // "dismissed" case below, which *does* leave it alone, for edit mode's own "unchanged"
      // default).
      options.wireCrypt = picked.label === "Enabled" ? undefined : picked.label as ConnectionOptions["wireCrypt"];
    }
    // Dismissed (Escape): leave options.wireCrypt untouched -- in edit mode that means "keep the
    // existing value" (already pre-populated before this step ran); in create mode it was never
    // set to begin with, same as picking "Enabled" explicitly.

    return (input: MultiStepInput) => sshTunnel(input, options, step + 1, totalSteps);
  }

  async function sshTunnel(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ) {
    const items: QuickPickItem[] = [
      { label: "No", description: "Connect directly (default)" },
      { label: "Yes", description: "Connect through an SSH bastion/jump host" }
    ];

    const picked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items,
      placeholder: "[OPTIONAL] Connect through an SSH tunnel?",
      ignoreFocusOut: true
    });

    if (picked?.label === "No") {
      // Explicit "No": clear any existing tunnel config -- distinct from dismissing (below),
      // which in edit mode should leave a pre-populated existing.sshTunnel untouched instead.
      options.sshTunnel = undefined;
      options.sshTunnelPassword = undefined;
      return (input: MultiStepInput) => testConnection(input, options, step, totalSteps);
    }
    if (!picked) {
      return (input: MultiStepInput) => testConnection(input, options, step, totalSteps);
    }

    const sshHost = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[REQUIRED] SSH bastion/jump host.",
      placeHolder: "e.g. 'bastion.example.com'",
      ignoreFocusOut: true
    });
    if (!sshHost) {
      return Promise.reject("SSH host cannot be empty. Add Connection canceled.");
    }

    const sshPortInput = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[OPTIONAL] SSH port. Leave empty for default.",
      placeHolder: "defaults to 22",
      ignoreFocusOut: true
    });
    const sshPort = sshPortInput ? (Number.parseInt(sshPortInput) || 22) : 22;

    const sshUser = await input.showInputBox({
      title,
      step,
      totalSteps,
      prompt: "[REQUIRED] SSH username.",
      placeHolder: "e.g. 'ec2-user'",
      ignoreFocusOut: true
    });
    if (!sshUser) {
      return Promise.reject("SSH user cannot be empty. Add Connection canceled.");
    }

    const authItems: QuickPickItem[] = [
      { label: "Password", description: "Authenticate with an SSH password" },
      { label: "Private Key", description: "Authenticate with an OpenSSH-format private key file" },
      { label: "SSH Agent", description: "Use the running SSH agent (SSH_AUTH_SOCK)" }
    ];
    const authPicked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items: authItems,
      placeholder: "SSH authentication method",
      ignoreFocusOut: true
    });
    if (!authPicked) {
      return Promise.reject("SSH authentication method not selected. Add Connection canceled.");
    }

    const authMethod: "password" | "privateKey" | "agent" =
      authPicked.label === "Private Key" ? "privateKey" : authPicked.label === "SSH Agent" ? "agent" : "password";

    let privateKeyPath: string | undefined;
    if (authMethod === "privateKey") {
      const openUris = await window.showOpenDialog({
        title: "Select SSH Private Key File",
        canSelectMany: false
      });
      if (!openUris || openUris.length === 0) {
        return Promise.reject("No private key file selected. Add Connection canceled.");
      }
      privateKeyPath = openUris[0].fsPath;
    }

    options.sshTunnel = { host: sshHost, port: sshPort, user: sshUser, authMethod, privateKeyPath };

    if (authMethod !== "agent") {
      options.sshTunnelPassword = await input.showInputBox({
        title,
        step,
        totalSteps,
        prompt: authMethod === "privateKey"
          ? "[OPTIONAL] Passphrase for the private key. Leave empty if it's not encrypted."
          : "[REQUIRED] SSH password.",
        placeHolder: authMethod === "privateKey" ? "Leave empty if not encrypted" : "",
        ignoreFocusOut: true,
        password: true
      });
    }
    // No testConnection step here: CredentialStore.getSshPassword() (which SshTunnelClient's
    // connect path requires) is keyed by a saved connection's id, which doesn't exist yet at this
    // point in the wizard -- testing an SSH-tunneled connection reliably needs the credential to
    // already be stored, which only happens once this connection is actually saved.
    return undefined;
  }

  /**
   * "Test Connection" (docs/roadmap/connection-management-enhancements.md, phase 1): a real
   * connect-then-detach against the collected (but not yet saved) options, surfacing a wrong
   * password or unreachable host before the connection is added to the tree rather than only on
   * first use afterward. Optional (defaults to "Save Without Testing") and never a hard block --
   * a failed test still offers "Save Anyway", matching this wizard's existing non-blocking
   * posture elsewhere (e.g. a malformed pasted connection string just falls through to the
   * guided wizard rather than refusing outright).
   */
  async function testConnection(
    input: MultiStepInput,
    options: Partial<ConnectionOptions>,
    step: number,
    totalSteps: number
  ): Promise<InputStep | void> {
    const items: QuickPickItem[] = [
      { label: "$(plug) Test Connection", description: "Try connecting now, before saving" },
      { label: "$(check) Save Without Testing", description: "Skip the test and save as-is" }
    ];

    const picked = await input.showQuickPick({
      title,
      step,
      totalSteps,
      items,
      placeholder: "Test the connection before saving?",
      ignoreFocusOut: true
    });

    if (!picked || picked.label.includes("Save Without Testing")) {
      return undefined;
    }

    const error = await attemptConnection(options as ConnectionOptions);
    if (!error) {
      window.showInformationMessage("✅ Connection successful.");
      return undefined;
    }

    const choice = await window.showErrorMessage(`❌ Connection failed: ${error}`, "Retry", "Save Anyway");
    if (choice === "Retry") {
      return (input: MultiStepInput) => testConnection(input, options, step, totalSteps);
    }
    return undefined;
  }

  return await collectInputs();
}

/** Real connect-then-detach; returns the error message on failure, undefined on success. */
/** Exported for suite-tier testing against a real server — real connect-then-detach, no throw. */
export async function attemptConnection(options: ConnectionOptions): Promise<string | undefined> {
  return window.withProgress(
    { location: ProgressLocation.Notification, title: `Testing connection to ${options.host || options.database}...`, cancellable: false },
    async () => {
      try {
        const connection = await Driver.client.createConnection(options);
        await Driver.client.detach(connection);
        return undefined;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    }
  );
}

class InputFlowAction {
  static back = new InputFlowAction();
  static cancel = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface InputBoxParameters {
  title: string;
  step: number;
  totalSteps: number;
  prompt: string;
  placeHolder: string;
  ignoreFocusOut: boolean;
  password?: boolean;
  /** Pre-fills the input box (e.g. a database path suggested from Docker container discovery); still freely editable. */
  value?: string;
}

interface QuickPickParameters {
  title: string;
  step: number;
  totalSteps: number;
  items: QuickPickItem[];
  placeholder: string;
  ignoreFocusOut: boolean;
}

class MultiStepInput {
  static async run(start: InputStep) {
    const input = new MultiStepInput();
    return input.stepThrough(start);
  }

  private current?: QuickInput;
  private steps: InputStep[] = [];

  private async stepThrough(start: InputStep) {
    let step: InputStep | void = start;
    while (step) {
      this.steps.push(step);
      try {
        step = await step(this);
      } catch (err) {
        if (err === InputFlowAction.back) {
          this.steps.pop();
          step = this.steps.pop();
        } else if (err === InputFlowAction.cancel) {
          step = undefined;
        } else {
          this.current?.dispose();
          throw err;
        }
      }
    }
    if (this.current) {
      this.current.dispose();
    }
  }

  async showQuickPick<P extends QuickPickParameters>({
    title,
    step,
    totalSteps,
    items,
    placeholder,
    ignoreFocusOut
  }: P): Promise<QuickPickItem | undefined> {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<QuickPickItem | undefined>((resolve, reject) => {
        const pick = window.createQuickPick<QuickPickItem>();
        pick.title = title;
        pick.step = step;
        pick.totalSteps = totalSteps;
        pick.items = items;
        pick.placeholder = placeholder;
        pick.ignoreFocusOut = ignoreFocusOut;
        pick.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : [])];
        disposables.push(
          pick.onDidTriggerButton(button => {
            if (button === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(undefined);
            }
          }),
          pick.onDidAccept(() => {
            resolve(pick.selectedItems[0]);
          }),
          pick.onDidHide(() => {
            resolve(undefined);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = pick;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  async showInputBox<P extends InputBoxParameters>({
    title,
    step,
    totalSteps,
    prompt,
    placeHolder,
    ignoreFocusOut,
    password,
    value
  }: P) {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
        const input = window.createInputBox();
        input.title = title;
        input.step = step;
        input.totalSteps = totalSteps;
        input.prompt = prompt;
        input.placeholder = placeHolder;
        input.ignoreFocusOut = ignoreFocusOut;
        input.password = password || false;
        input.value = value || "";
        input.buttons = [...(this.steps.length > 1 ? [QuickInputButtons.Back] : [])];
        disposables.push(
          input.onDidTriggerButton(button => {
            if (button === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>button);
            }
          }),
          input.onDidAccept(async () => {
            const value = input.value;
            resolve(value);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }
}

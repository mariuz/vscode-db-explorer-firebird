/**
 * Backup/Restore: Expose gbak Options (docs/roadmap/backup-restore-options.md), phase 1 — pure
 * flag-building for `gbak`'s own backup switches, verified directly against a real `gbak -z`
 * (Firebird 6.0) rather than trusted from memory; kept here (not inline in node-database.ts) so
 * it's unit-testable without needing a real child process or file dialogs.
 */

export interface BackupFlagChoices {
  /** `-G` — inhibit garbage collection during backup; faster, but doesn't reclaim space. */
  skipGarbageCollection?: boolean;
  /** `-ZIP` — the backup file itself is zip-compressed. */
  compress?: boolean;
  /** `-M` — backup schema only, no table data. */
  metadataOnly?: boolean;
  /** `-NT` — non-transportable format: smaller/faster, but only restorable on the same platform/architecture it was taken on. Firebird's own default is transportable. */
  nonTransportable?: boolean;
}

/** Returns the extra gbak flags for the given choices — [] when every choice is unset, matching gbak's own defaults exactly. */
export function buildBackupFlags(choices: BackupFlagChoices): string[] {
  const flags: string[] = [];
  if (choices.skipGarbageCollection) { flags.push("-G"); }
  if (choices.compress) { flags.push("-ZIP"); }
  if (choices.metadataOnly) { flags.push("-M"); }
  if (choices.nonTransportable) { flags.push("-NT"); }
  return flags;
}

/**
 * Restore options (docs/roadmap/backup-restore-options.md, phase 2). Flag letters verified against
 * a real `gbak`'s own help output (Firebird 6.0), not from memory — `-K(ILL)` is "restore without
 * creating shadows", `-N(O_VALIDITY)` is "do not restore database validity conditions",
 * `-O(NE_AT_A_TIME)` is "restore one table at a time", `-P(AGE_SIZE)` takes a value, and
 * `-M(ETA_DATA)` is documented as "backup **or restore** metadata only", which is why the same flag
 * appears in both this and BackupFlagChoices.
 */
export interface RestoreFlagChoices {
  /** `-M` — restore the schema only, no table data. */
  metadataOnly?: boolean;
  /** `-O` — restore one table at a time; slower, but lets a restore past a single corrupt table. */
  oneAtATime?: boolean;
  /** `-N` — don't restore validity constraints (NOT NULL/CHECK), for data that would fail them. */
  noValidity?: boolean;
  /** `-K` — don't recreate the database's shadow files. */
  noShadows?: boolean;
  /** `-P <size>` — override the page size the backup recorded. */
  pageSize?: number;
}

/**
 * How the target database is created — a *top-level* switch, used instead of the other, not
 * alongside it. `-C` fails outright if the target file already exists, which is today's behavior
 * and the safe default; `-REP` replaces an existing database.
 */
export type RestoreMode = "create" | "replace";

/** Page sizes gbak accepts for `-P`. */
export const RESTORE_PAGE_SIZES = [4096, 8192, 16384, 32768] as const;

/** The modifier flags for the given restore choices — [] when everything is unset, matching gbak's own defaults. */
export function buildRestoreFlags(choices: RestoreFlagChoices): string[] {
  const flags: string[] = [];
  if (choices.metadataOnly) { flags.push("-M"); }
  if (choices.oneAtATime) { flags.push("-O"); }
  if (choices.noValidity) { flags.push("-N"); }
  if (choices.noShadows) { flags.push("-K"); }
  if (choices.pageSize) { flags.push("-P", String(choices.pageSize)); }
  return flags;
}

export interface RestoreArgsParams {
  mode: RestoreMode;
  choices: RestoreFlagChoices;
  user: string;
  password: string;
  /**
   * The backup volume(s) being restored from, in order. A multi-file backup **must** list every
   * volume: confirmed live that handing gbak only the first file of a two-file backup makes it
   * consume the target path as the next backup volume and fail with "cannot open backup file
   * <target>" — a confusing error that looks like a permissions problem rather than a missing file.
   */
  backupPaths: string[];
  /** The target, as gbak wants it — `host/port:/path/to.fdb`. */
  target: string;
  /** `-PAR <n>` workers; 1/undefined emits nothing. */
  parallelWorkers?: number;
}

/**
 * The complete gbak argument list for a restore. Assembled here rather than inline at the call site
 * specifically so the command *preview* shown to the user and the command actually executed are
 * built by the same function — a preview that can drift from what runs is worse than no preview.
 */
export function buildRestoreArgs(params: RestoreArgsParams): string[] {
  return [
    params.mode === "replace" ? "-REP" : "-C",
    ...buildRestoreFlags(params.choices),
    ...buildParallelFlag(params.parallelWorkers),
    "-user", params.user,
    "-password", params.password,
    ...params.backupPaths,
    params.target,
  ];
}

/**
 * Renders a gbak invocation for display — **not** for execution: arguments are quoted only enough
 * to be readable, and the password is replaced with `********`. The whole point of the preview is
 * to let someone confirm a destructive restore, so showing them their own password would be a poor
 * trade for that.
 */
export function renderGbakCommand(executable: string, args: string[]): string {
  const rendered = args.map((arg, index) => {
    const previous = args[index - 1]?.toLowerCase();
    const value = previous === "-password" || previous === "-pas" ? "********" : arg;
    return /\s/.test(value) ? `"${value}"` : value;
  });
  return [/\s/.test(executable) ? `"${executable}"` : executable, ...rendered].join(" ");
}


/**
 * Parallel workers (docs/roadmap/backup-restore-options.md, phase 4) — `gbak -PAR <n>`, valid for
 * both backup and restore. `1` (or unset) emits nothing, since one worker *is* gbak's default and
 * an explicit `-PAR 1` would only add noise to the command preview.
 */
export function buildParallelFlag(workers: number | undefined): string[] {
  return workers && workers > 1 ? ["-PAR", String(workers)] : [];
}

/**
 * The server's `MaxParallelWorkers` ceiling, read from the `RDB$CONFIG` rows returned by
 * `getMaxParallelWorkersQuery()`. Falls back to 1 — "no parallelism available" — for any shape this
 * doesn't recognize, which is the safe direction: offering a value the server rejects produces a
 * gbak warning and a silently single-threaded run.
 */
export function parseMaxParallelWorkers(rows: any[] | undefined): number {
  const raw = rows?.[0]?.MAX_WORKERS ?? rows?.[0]?.["MAX_WORKERS"];
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}

/**
 * Multi-file backup (docs/roadmap/backup-restore-options.md, phase 4) — gbak takes the volumes as
 * `file1 <size> file2 <size> … fileN`, where every file *except the last* carries a size and the
 * last one absorbs whatever is left. Confirmed live against a real gbak: backing up with
 * `/tmp/mf1.fbk 40k /tmp/mf2.fbk` produced a 40960-byte first volume and a second holding the rest.
 *
 * Volume names are derived from the chosen path so the user picks one file, not N: `backup.fbk`
 * becomes `backup.fbk`, `backup.2.fbk`, `backup.3.fbk`, … — predictable, and keeps the extension so
 * the OS still recognizes each part.
 *
 * A `volumeCount` of 1 (or less) returns just the base path, i.e. exactly the single-file behavior.
 */
export function buildMultiFileTargets(basePath: string, volumeCount: number, volumeSize: string): string[] {
  if (!Number.isFinite(volumeCount) || volumeCount <= 1) {
    return [basePath];
  }
  const dot = basePath.lastIndexOf(".");
  const stem = dot > 0 ? basePath.slice(0, dot) : basePath;
  const extension = dot > 0 ? basePath.slice(dot) : "";

  const args: string[] = [];
  for (let volume = 1; volume <= volumeCount; volume++) {
    args.push(volume === 1 ? basePath : `${stem}.${volume}${extension}`);
    if (volume < volumeCount) {
      args.push(volumeSize); // every volume but the last is sized
    }
  }
  return args;
}

/** Accepts gbak's own volume-size forms: a bare page count, or a number suffixed k/m/g. */
export function isValidVolumeSize(value: string): boolean {
  return /^\d+[kmg]?$/i.test(value.trim());
}

/**
 * `gbak` has no established alternate name the way isql does (isql-fb vs. isql, to dodge
 * unixODBC's own isql) — one candidate name per platform.
 */
export function gbakCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["gbak.exe"] : ["gbak"];
}

/**
 * Resolves which gbak executable to launch — mirrors isql-terminal.ts's resolveIsqlExecutable()
 * and docker-discovery.ts's resolveDockerExecutable() exactly (this codebase already keeps these
 * three small and independent rather than sharing one abstraction between them): an explicit
 * `customPath` (the firebird.gbakPath setting) always wins if it actually resolves; otherwise
 * tries gbak on PATH. `checkExecutable` is injected so this is unit-testable without a real gbak
 * binary; extension.ts supplies a real spawn-based check.
 */
export async function resolveGbakExecutable(
  customPath: string | undefined,
  checkExecutable: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<string | undefined> {
  if (customPath) {
    return (await checkExecutable(customPath)) ? customPath : undefined;
  }
  for (const candidate of gbakCandidates(platform)) {
    if (await checkExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

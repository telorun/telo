import {
  DURABLE_DIRECTORY_TYPE,
  STATE_DIR_HOST_VALUE,
  type NeedEnvironmentEntry,
  type NeedTableEntry,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { withoutHostValues } from "./host-values.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The kernel half of `Telo.DurableDirectory`: answering a need from the host's
 * state directory, refusing a load that would strand files under it, and
 * checking that every directory — however supplied — is one the process can
 * write to. What a manifest is held to statically is the analyzer's
 * (`durable-directory.ts`, the need table).
 */

/** Where every answered directory and every orphan lives, under the state dir. */
const NEEDS_DIRECTORY = "needs";

/** Where every child application's own state directory lives, under the state dir. */
const APPLICATIONS_DIRECTORY = "apps";

/** A need path as the name of its directory: one segment, its parts joined by
 *  `.` — a need or alias name never holds one, so no two paths share a name. */
function directoryName(entry: { path: readonly string[] }): string {
  return entry.path.join(".");
}

/** The state directory the host set, made absolute, or undefined when unset. */
export function stateDirectoryOf(env: Record<string, string | undefined>): string | undefined {
  const raw = env[STATE_DIR_HOST_VALUE];
  return raw === undefined || raw === "" ? undefined : path.resolve(raw);
}

/** Every durable directory need the environment leaves unset that the state
 *  directory answers, with the directory it gets: `<state dir>/needs/<need path>`. */
export function stateDirectoryAnswers(
  entries: readonly NeedEnvironmentEntry[],
  env: Record<string, string | undefined>,
): Map<NeedEnvironmentEntry, string> {
  const answers = new Map<NeedEnvironmentEntry, string>();
  const root = stateDirectoryOf(env);
  if (root === undefined) return answers;
  for (const entry of entries) {
    const field = entry.need.type === DURABLE_DIRECTORY_TYPE ? entry.fields?.path : undefined;
    if (!field || (env[field.env] !== undefined && env[field.env] !== "")) continue;
    answers.set(entry, path.join(root, NEEDS_DIRECTORY, directoryName(entry)));
  }
  return answers;
}

/** The environment the root's needs are read from, with every durable directory
 *  the state directory answers read as if its env name held that directory. */
export function withStateDirectories(
  entries: readonly NeedEnvironmentEntry[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const answers = stateDirectoryAnswers(entries, env);
  if (answers.size === 0) return env;
  const derived: Record<string, string> = {};
  for (const [entry, directory] of answers) derived[entry.fields.path!.env] = directory;
  return { ...env, ...derived };
}

/** What a host is told of a stranded entry: refused, or warned about. */
export interface OrphanReport {
  /** Entries under `needs/` or `apps/` no declared path names, relative to the
   *  state dir. */
  orphans: string[];
}

/** The directory a child application of the application gets, relative to the
 *  state directory: `apps/<path>`, the path as a need path is — the module
 *  path and the resource's name, `.`-joined. */
export function applicationDirectory(path: readonly string[]): string {
  return `${APPLICATIONS_DIRECTORY}/${path.join(".")}`;
}

/** The environment a child application inherits: the parent's without its host
 *  values — which answer the parent's needs, never the child's — except a state
 *  directory the parent has, which is replaced by the child's own
 *  (`<state dir>/apps/<path>`), so the child's durable directories and its own
 *  children nest beneath it. The parent's is never handed on. */
export function childEnvironment(
  parentEnv: Record<string, string | undefined>,
  childPath: readonly string[] | undefined,
): Record<string, string | undefined> {
  const inherited = withoutHostValues(parentEnv);
  const root = stateDirectoryOf(parentEnv);
  if (root === undefined || childPath === undefined) return inherited;
  return { ...inherited, [STATE_DIR_HOST_VALUE]: path.join(root, applicationDirectory(childPath)) };
}

/** The entries of `<state dir>/<subtree>` no declared name matches. A name
 *  starting with '.' is no path, and is never one of ours. */
function strandedEntries(root: string, subtree: string, named: ReadonlySet<string>): string[] {
  let present: string[];
  try {
    present = fs.readdirSync(path.join(root, subtree));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RuntimeError(
      "ERR_NEED_DIRECTORY_UNUSABLE",
      `Host value ${STATE_DIR_HOST_VALUE}: its '${subtree}' directory cannot be read ` +
        `(${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`,
    );
  }
  return present
    .filter((name) => !name.startsWith(".") && !named.has(name))
    .sort()
    .map((name) => `${subtree}/${name}`);
}

/**
 * Scan the state directory's `needs/` and `apps/` for entries no durable
 * directory need and no child application of the application names — left
 * behind by a renamed need, import alias or instance. When this load would
 * create a fresh directory under the same subtree while such an entry exists,
 * the load is refused before any resource initializes; otherwise the entries
 * are returned for a warning. Nothing is moved or deleted.
 */
export function scanStateDirectory(
  env: Record<string, string | undefined>,
  answers: ReadonlyMap<NeedEnvironmentEntry, string>,
  declared: readonly NeedTableEntry[],
  applications: readonly (readonly string[])[] = [],
): OrphanReport {
  const root = stateDirectoryOf(env);
  if (root === undefined) return { orphans: [] };
  const named = new Set(
    declared.filter((entry) => entry.need.type === DURABLE_DIRECTORY_TYPE).map(directoryName),
  );
  const needOrphans = strandedEntries(root, NEEDS_DIRECTORY, named);
  const appNames = new Set(applications.map((appPath) => appPath.join(".")));
  const appOrphans = strandedEntries(root, APPLICATIONS_DIRECTORY, appNames);
  const refusals: string[] = [];
  if (needOrphans.length > 0) {
    const fresh = [...answers].filter(([, directory]) => !fs.existsSync(directory));
    if (fresh.length > 0) {
      const created = fresh
        .map(([entry]) => `'${NEEDS_DIRECTORY}/${directoryName(entry)}' for need '${entry.path.join(".")}'`)
        .join(", ");
      refusals.push(
        `${STATE_DIR_HOST_VALUE} holds ${needOrphans.map((o) => `'${o}'`).join(", ")}, which no ` +
          `${DURABLE_DIRECTORY_TYPE} need of this application names, and this load would create ` +
          `${created}. A renamed need or import alias gets a new path and so a new, empty directory: ` +
          `move the old directory to the new path to keep its files, or delete it. The state ` +
          `directory may also be shared with another application, which no host should do.`,
      );
    }
  }
  if (appOrphans.length > 0) {
    const fresh = applications.filter((appPath) => !fs.existsSync(path.join(root, applicationDirectory(appPath))));
    if (fresh.length > 0) {
      const created = fresh
        .map((appPath) => `'${applicationDirectory(appPath)}' for '${appPath.join(".")}'`)
        .join(", ");
      refusals.push(
        `${STATE_DIR_HOST_VALUE} holds ${appOrphans.map((o) => `'${o}'`).join(", ")}, which no ` +
          `application of this one names, and this load would create ${created}. A renamed instance ` +
          `gets a new path and so a new, empty directory: move the old directory to the new path to ` +
          `keep its files, or delete it.`,
      );
    }
  }
  if (refusals.length > 0) throw new RuntimeError("ERR_NEED_ORPHANED", refusals.join("\n"));
  return { orphans: [...needOrphans, ...appOrphans] };
}

/**
 * Create `<state dir>/apps/<path>` for every child application of the
 * application, as `needs/` directories are created at load — so one exists
 * after the first load and is never "fresh" again. Refused with
 * `ERR_NEED_DIRECTORY_UNUSABLE` when one cannot be created or written to.
 */
export function createApplicationDirectories(
  env: Record<string, string | undefined>,
  applications: readonly (readonly string[])[],
): void {
  const root = stateDirectoryOf(env);
  if (root === undefined) return;
  const lines: string[] = [];
  for (const appPath of applications) {
    const directory = path.join(root, applicationDirectory(appPath));
    const why = unusableDirectoryReason(directory);
    if (why) lines.push(`application '${appPath.join(".")}': '${directory}' is not usable — ${why}`);
  }
  if (lines.length === 0) return;
  throw new RuntimeError(
    "ERR_NEED_DIRECTORY_UNUSABLE",
    `Host value ${STATE_DIR_HOST_VALUE}: child application directories are not usable:\n` +
      lines.map((line) => `  - ${line}`).join("\n"),
  );
}

/** Why `directory` cannot be a durable directory, after creating it when it is
 *  absent; undefined when it is a directory the process can write to. */
export function unusableDirectoryReason(directory: string): string | undefined {
  try {
    if (!fs.statSync(directory).isDirectory()) return "it is not a directory";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return `it cannot be reached (${code ?? (err as Error).message})`;
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (created) {
      return `it does not exist and cannot be created (${(created as NodeJS.ErrnoException).code ?? (created as Error).message})`;
    }
  }
  try {
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    return "the process cannot write to it";
  }
  return undefined;
}

/** One durable directory to check, and where its value came from. */
export interface DirectoryToCheck {
  /** The need path, or the fulfilment a manifest writes. */
  subject: string;
  directory: unknown;
  /** The env name, host value or supply the value came from. */
  source: string;
}

/**
 * Refuse every directory that is not one the process can write to, creating
 * each that is absent — one error naming every refused need, its source and
 * what was wrong, never what the directory holds.
 */
export function refuseUnusableDirectories(directories: readonly DirectoryToCheck[]): void {
  const lines: string[] = [];
  for (const { subject, directory, source } of directories) {
    if (typeof directory !== "string") continue;
    const why = unusableDirectoryReason(directory);
    if (why) lines.push(`${subject}: '${directory}', from ${source}, is not usable — ${why}`);
  }
  if (lines.length === 0) return;
  throw new RuntimeError(
    "ERR_NEED_DIRECTORY_UNUSABLE",
    lines.length === 1
      ? `${DURABLE_DIRECTORY_TYPE} ${lines[0]}.`
      : `${DURABLE_DIRECTORY_TYPE} directories are not usable:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
  );
}

/** The durable directories the root reads from the environment, each with the
 *  env name or host value its directory came from. */
export function environmentDirectories(
  entries: readonly NeedEnvironmentEntry[],
  values: ReadonlyMap<string, Record<string, unknown> | null>,
  answers: ReadonlyMap<NeedEnvironmentEntry, string>,
): DirectoryToCheck[] {
  const out: DirectoryToCheck[] = [];
  for (const entry of entries) {
    if (entry.need.type !== DURABLE_DIRECTORY_TYPE) continue;
    const value = values.get(entry.path.join("."));
    const field = entry.fields?.path;
    if (!value || !field) continue;
    out.push({
      subject: `need '${entry.path.join(".")}'`,
      directory: value.path,
      source: answers.has(entry) ? STATE_DIR_HOST_VALUE : field.env,
    });
  }
  return out;
}

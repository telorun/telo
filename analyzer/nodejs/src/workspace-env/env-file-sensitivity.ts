/**
 * Which env files are sensitive, and what follows from it.
 *
 * Sensitive means a file holds values that must not be committed or synced —
 * an `env.files` entry marked `sensitive: true`, or `.env.local` while no
 * `files:` is declared. Every consumer reads the mark from here: where
 * `telo env template` and Studio write a secret, the warning a run prints for a
 * secret read from a file without the mark, and which files a whole-tree copy
 * (a cloud working copy, an agent's session) leaves out. Log redaction is
 * unrelated: it stays keyed on what a manifest declares as secret.
 */

import {
  DEFAULT_ENV_FILES,
  WORKSPACE_FILENAME,
  diagnosticsFor,
  hasError,
  readWorkspaceConfig,
  type EnvFileEntry,
} from "../release/workspace-config.js";
import type { SensitiveEnvironmentInput } from "../sensitive-environment-inputs.js";
import type { ReadEnvFile, WorkspaceEnvResolution } from "./env-file-resolution.js";

/**
 * The entry a value is written to: for a sensitive value the LAST sensitive
 * entry of `env.files`, for any other the last one that is not — the later
 * entry being the one that wins a conflict. Refused, naming `env.files` and what
 * to add, when the workspace declares no entry of the kind needed.
 */
export function envFileDestination(
  entries: readonly EnvFileEntry[],
  sensitive: boolean,
): { readonly name: string } | { readonly refused: string } {
  const entry = entries.filter((candidate) => candidate.sensitive === sensitive).pop();
  if (entry) return { name: entry.name };
  return {
    refused: sensitive
      ? `env.files in ${WORKSPACE_FILENAME} marks no file sensitive, so a secret has no file that is kept ` +
        `out of version control. Mark one 'sensitive: true', or add { name: .env.local, sensitive: true }.`
      : `env.files in ${WORKSPACE_FILENAME} declares only sensitive files, so a value that may be committed ` +
        `has no file of its own. Add a filename that is not marked sensitive, such as .env.`,
  };
}

/** A sensitive environment input whose value a run takes from a file without
 *  the sensitive mark. */
export interface SensitiveValueFinding {
  readonly input: SensitiveEnvironmentInput;
  readonly file: string;
}

/**
 * Every sensitive input whose applied value comes from a file `env.files` does
 * not mark sensitive. `applied` names the variables the resolution actually
 * supplied — a run leaves out every one the real environment already set, so a
 * value it did not read from a file is not one to warn about.
 */
export function sensitiveValueFindings(
  resolution: WorkspaceEnvResolution,
  applied: Iterable<string>,
  inputs: readonly SensitiveEnvironmentInput[],
): SensitiveValueFinding[] {
  const supplied = new Set(applied);
  const sensitiveFiles = new Set(resolution.files.filter((file) => file.sensitive).map((file) => file.path));
  const findings: SensitiveValueFinding[] = [];
  for (const input of inputs) {
    const file = resolution.sources[input.env];
    if (file === undefined || !supplied.has(input.env) || sensitiveFiles.has(file)) continue;
    findings.push({ input, file });
  }
  return findings;
}

/** The warning for one finding, the file as `shownFile` — a path the reader
 *  recognizes, which only the host can render. */
export function describeSensitiveValueFinding(finding: SensitiveValueFinding, shownFile: string): string {
  return (
    `${finding.input.source} ${finding.input.env} is set in ${shownFile}, which env.files does not ` +
    `mark sensitive — move it to a sensitive file`
  );
}

/** Which of a tree's paths are sensitive, or why that cannot be decided. */
export type SensitiveEnvFiles = { readonly sensitive: ReadonlySet<string> } | { readonly failed: string };

/**
 * The paths of a whole tree that are sensitive env files.
 *
 * A file is sensitive when its basename is a sensitive entry of the NEAREST
 * marker at or above it among `paths` — a nested marker governs the runs in its
 * subtree, so it governs the files they read — and `.env.local` is sensitive
 * where no marker governs. `paths` are `/`-separated, all relative to the tree's
 * root or all absolute; each `telo-workspace.yaml` among them is read through
 * `read`. One whose `env:` has an error, or that cannot be read, makes the whole
 * answer a refusal with its message: deciding without it would treat a secret
 * as an ordinary file.
 */
export async function classifySensitiveEnvFiles(
  paths: readonly string[],
  read: ReadEnvFile,
): Promise<SensitiveEnvFiles> {
  const governing = new Map<string, ReadonlySet<string>>();
  for (const path of paths) {
    if (basenameOf(path) !== WORKSPACE_FILENAME) continue;
    const found = await read(path);
    if (found.kind === "missing" || found.kind === "not-a-file") continue;
    if (found.kind === "unreadable") {
      return { failed: `${path} could not be read (${found.reason}), so which env files are sensitive is unknown.` };
    }
    const { config, diagnostics } = readWorkspaceConfig(found.text, path);
    const envErrors = diagnosticsFor(diagnostics, "env");
    if (hasError(envErrors)) return { failed: envErrors.find((d) => d.severity === "error")!.message };
    governing.set(directoryOf(path), sensitiveNames(config.env?.files ?? DEFAULT_ENV_FILES));
  }

  const defaults = sensitiveNames(DEFAULT_ENV_FILES);
  const markers = [...governing.keys()].sort((a, b) => b.length - a.length);
  const sensitive = new Set<string>();
  for (const path of paths) {
    const directory = directoryOf(path);
    const nearest = markers.find((marker) => isAtOrBelow(directory, marker));
    const names = nearest === undefined ? defaults : governing.get(nearest)!;
    if (names.has(basenameOf(path))) sensitive.add(path);
  }
  return { sensitive };
}

function sensitiveNames(entries: readonly EnvFileEntry[]): ReadonlySet<string> {
  return new Set(entries.filter((entry) => entry.sensitive).map((entry) => entry.name));
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Everything before the last `/` — `''` for a file at a relative tree's root. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function isAtOrBelow(directory: string, ancestor: string): boolean {
  return ancestor === "" || directory === ancestor || directory.startsWith(`${ancestor}/`);
}

/**
 * `telo-workspace.yaml` — the release anchor.
 *
 * Every path the release system names — a module key, a ledger entry, a
 * fragment's `modules:` — is relative to this file's directory. That is the
 * whole of its job: **its location is the anchor**, and its one field names the
 * subtrees that may hold modules, which is not derivable (a whole-tree scan
 * would read every example and every cached `.telo/manifests` copy as a released
 * module).
 *
 * The file is **optional and read only by `telo release`**. Nothing else — not
 * `run`, `check`, `publish`, `install`, `upgrade`, `migrate`, `module`, and not
 * the kernel — looks for it, so a single-manifest repo, a bare `examples/`
 * directory and a third-party module checkout keep working with nothing added.
 * Any field added later must be true of the whole tree, not derivable from it,
 * and harmless by its absence.
 *
 * Parsing lives here, in the browser-safe half, because the editor answers
 * "what does changing this library bump?" from the same model. Finding the file
 * on disk is the CLI's half — this side takes text.
 */

import { parseDocument } from "yaml";

export const WORKSPACE_FILENAME = "telo-workspace.yaml";

export interface WorkspaceConfig {
  /**
   * Gitignore-style patterns, workspace-relative, naming the subtrees that may
   * hold modules (`modules/*`, `apps/*`). A pattern names a place to look, never
   * a module: what makes a directory a module is its `telo.yaml`.
   */
  readonly modules: readonly string[];
}

export class WorkspaceConfigError extends Error {}

/**
 * Parse the marker file's text.
 *
 * Strict about its one field, because there is nothing here to be lenient with:
 * an empty or absent `modules:` names no subtree, so discovery would find no
 * module and every gate would silently pass over a whole repo.
 */
export function parseWorkspaceConfig(text: string, where: string): WorkspaceConfig {
  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    throw new WorkspaceConfigError(
      `${where} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceConfigError(`${where} must be a YAML mapping.`);
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== "modules") {
      throw new WorkspaceConfigError(
        `${where}: unknown field '${key}'. The workspace marker carries only 'modules:' — ` +
          `the subtrees that may hold modules.`,
      );
    }
  }

  const modules = record.modules;
  if (!Array.isArray(modules) || modules.some((entry) => typeof entry !== "string")) {
    throw new WorkspaceConfigError(
      `${where}: 'modules' must be a list of path patterns, e.g. [modules/*, apps/*].`,
    );
  }
  if (modules.length === 0) {
    throw new WorkspaceConfigError(
      `${where}: 'modules' is empty, so no directory can ever be discovered as a module. ` +
        `List the subtrees that hold them, e.g. [modules/*, apps/*].`,
    );
  }
  return { modules: modules as string[] };
}

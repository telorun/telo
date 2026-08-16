/**
 * A release fragment — one pending change, written by an author.
 *
 * The shape is changesets' (one file, several modules, one body) carrying
 * changie's kind vocabulary, which is what lets one cross-cutting change be one
 * file while the kind still drives both the level and the changelog section a
 * line lands under. Changie's own file is the other arrangement — one module per
 * file — so a change touching five modules meant five files repeating one
 * sentence, and its key was the module's bare directory NAME, which two
 * directories in different subtrees can share.
 *
 * A fragment names modules by **workspace-relative path**, the same key the
 * ledger and every diagnostic use.
 *
 * They are plain YAML validated here, not a `Telo.*` kind: build-time repo state
 * with no controller and no capability, which the runtime never loads.
 */

import { Document, parseDocument } from "yaml";
import { isFragmentKind, type FragmentKind } from "./bump-level.js";

/** A module's workspace-relative directory path — `modules/sql`, `apps/hub`. */
export type ModuleKey = string;

export interface ReleaseFragment {
  /**
   * Where this fragment was read from, workspace-relative. Carried so a
   * diagnostic can name the file to fix and `apply` can delete the file it
   * consumed.
   */
  readonly source: string;
  /** The directly-changed modules this fragment declares, each with its kind. */
  readonly modules: ReadonlyMap<ModuleKey, FragmentKind>;
  /** The changelog line. */
  readonly body: string;
}

export class FragmentError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseFragment(text: string, source: string): ReleaseFragment {
  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    throw new FragmentError(
      source,
      `${source} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FragmentError(source, `${source} must be a YAML mapping.`);
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== "modules" && key !== "body") {
      throw new FragmentError(
        source,
        `${source}: unknown field '${key}'. A fragment carries 'modules:' and 'body:'.`,
      );
    }
  }

  const rawModules = record.modules;
  if (rawModules === null || typeof rawModules !== "object" || Array.isArray(rawModules)) {
    throw new FragmentError(
      source,
      `${source}: 'modules' must be a mapping of module path to kind, ` +
        `e.g. { modules/sql: Fixed }.`,
    );
  }
  const modules = new Map<ModuleKey, FragmentKind>();
  for (const [key, kind] of Object.entries(rawModules as Record<string, unknown>)) {
    if (!isFragmentKind(kind)) {
      throw new FragmentError(
        source,
        `${source}: '${key}' declares kind '${String(kind)}', which is not a release kind. ` +
          `Use Added, Changed, Deprecated, Removed, Fixed or Security.`,
      );
    }
    modules.set(normalizeModuleKey(key), kind);
  }
  if (modules.size === 0) {
    throw new FragmentError(
      source,
      `${source}: 'modules' is empty, so this fragment releases nothing. ` +
        `Name at least one module by its workspace-relative path.`,
    );
  }

  const body = record.body;
  if (typeof body !== "string" || body.trim() === "") {
    throw new FragmentError(
      source,
      `${source}: 'body' must be the changelog line for this change.`,
    );
  }

  return { source, modules, body: body.trim() };
}

/**
 * Render a fragment, for `telo release add`.
 *
 * Serialized rather than templated so a long body folds the way the YAML writer
 * folds it, and so a module path needing quotes gets them.
 */
export function serializeFragment(
  modules: ReadonlyMap<ModuleKey, FragmentKind>,
  body: string,
): string {
  const doc = new Document({
    modules: Object.fromEntries([...modules].map(([key, kind]) => [key, kind])),
    body,
  });
  return doc.toString({ lineWidth: 88 });
}

/** Module keys are POSIX-separated and carry no leading `./` or trailing slash,
 *  so the same directory written three ways is one key. */
export function normalizeModuleKey(key: string): ModuleKey {
  return key.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

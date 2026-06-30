import path from "node:path";

/** A resource manifest as it reaches a controller's `create`: config fields sit
 *  at the top level beside `metadata`. Every fs kind shares the optional `cwd`. */
export interface FsManifest {
  metadata: { name: string; module: string };
  cwd?: string;
}

/** Resolve the base directory invoke paths are taken relative to. A relative
 *  `cwd` (and the default) resolves against the process working directory. */
export function resolveBase(cwd?: string): string {
  return path.resolve(cwd ?? ".");
}

/** Resolve an invoke `path` against the resource base. An absolute input path is
 *  used as-is. */
export function resolveTarget(base: string, target: string): string {
  return path.resolve(base, target);
}

export function requirePath(kind: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${kind}: 'path' input is required and must be a non-empty string`);
  }
  return value;
}

const REASONS: Record<string, string> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  EEXIST: "already exists",
  ENOTEMPTY: "directory not empty",
};

/** Turn a Node fs error into an actionable, path-naming message that preserves
 *  the original code so callers (and tests) can branch on it. */
export function wrapFsError(action: string, target: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code;
  const reason = (code && REASONS[code]) ?? e?.message ?? String(err);
  return new Error(`${action} '${target}': ${reason}${code ? ` (${code})` : ""}`, { cause: err });
}

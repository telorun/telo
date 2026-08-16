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

/** The relative path of `full` under `base`, in the form a MANIFEST sees.
 *
 *  A path that crosses into manifest data is not a host path any more: an author
 *  compares it in CEL (`f.path == 'a/b.txt'`) and the manifest that does so runs
 *  on every platform, so `path.relative` alone made the same expression match on
 *  Linux and miss on Windows, where it yields `a\b.txt`. Separators are POSIX
 *  here for the same reason module refs, `include:` globs and `!include-text`
 *  paths are — every path the manifest layer can name is written one way.
 *
 *  Emission only. Input paths keep going through `resolveTarget`, which accepts
 *  either separator via `path.resolve`. */
export function toManifestPath(base: string, full: string): string {
  return path.relative(base, full).split(path.sep).join("/");
}

export function requirePath(kind: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${kind}: 'path' input is required and must be a non-empty string`);
  }
  return value;
}

/** Content a write kind accepts: text (interpreted per `encoding`) or raw bytes
 *  taken verbatim from whatever produced them. */
export type WritableContent = string | Uint8Array;

/** Normalize write content to the bytes that hit disk. A string is decoded per
 *  `encoding`; a Uint8Array is wrapped without copying and `encoding` does not
 *  apply to it — it is already bytes, not a rendering of them. */
export function toWritableBytes(kind: string, content: unknown, encoding?: string): Buffer {
  if (typeof content === "string") {
    return Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new Error(
    `${kind}: 'content' must be text or raw bytes, got ${describeContent(content)}. ` +
      `Bytes come from a resource that produces them (a generated image, a decoded payload) — ` +
      `they cannot be written inline in a manifest; use a string with 'encoding: base64' for that.`,
  );
}

/** Name what actually arrived. The slot is `anyOf: [string, x-telo-binary]`, so a
 *  plain object is rejected before this — statically for a literal, by the input
 *  contract for a CEL value. This survives as defence in depth for a caller that
 *  reaches the controller some other way, and the distinction it draws (a byte
 *  buffer vs. a plain object) is the one "got object" would hide. */
function describeContent(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    return name && name !== "Object" ? `a ${name}` : "a plain object";
  }
  return `a ${typeof value}`;
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

import { posix } from "node:path";

export class BundlePathError extends Error {}

/**
 * Bundle file paths arrive POSIX-style and untrusted. Guard against traversal
 * explicitly rather than trusting `path.resolve` — an `entryRelativePath` or
 * `files[].relativePath` of `../foo` would escape the session's own directory.
 * Backend-neutral: every backend normalizes paths the same way before placing
 * files, regardless of how it ultimately delivers the bundle.
 */
export function normalizeBundlePath(p: string): string {
  const normalized = posix.normalize(p).replace(/^\/+/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new BundlePathError(`invalid bundle relativePath '${p}'`);
  }
  for (const part of normalized.split("/")) {
    if (part === "..") throw new BundlePathError(`invalid bundle relativePath '${p}'`);
  }
  return normalized;
}

export function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new BundlePathError(`invalid sessionId '${id}' (must match /^[a-zA-Z0-9_-]+$/)`);
  }
}

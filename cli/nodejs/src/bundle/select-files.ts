import ignore from "ignore";
import * as fs from "fs";
import * as path from "path";

/**
 * Files that must never ship inside a module artifact, regardless of what the
 * author's `files:` patterns select. Applied as a second, non-overridable deny
 * pass after the allowlist — a `files:` pattern cannot opt these back in.
 */
const DEFAULT_IGNORE: readonly string[] = [
  "node_modules/",
  ".git/",
  ".telo/", // the manifest cache — bundling it would recurse
  ".telobundle.*", // controller-bundle output
];

/**
 * Select files under `manifestDir` matching the ordered, `.gitignore`-style
 * allowlist `patterns` (positive patterns opt in, `!` patterns carve out,
 * last-match-wins) using the same `ignore` engine git uses. Returns
 * manifest-relative POSIX paths, sorted for determinism.
 *
 * `ignore().ignores(p)` returns `true` when `p` matches the rule set — we
 * reinterpret "matched" as "selected", so `!` negation subtracts exactly as in
 * `.gitignore`. The `DEFAULT_IGNORE` set is subtracted afterwards and cannot be
 * re-included.
 *
 * Throws if a selected file resolves (via a symlink) outside `manifestDir`.
 */
export function selectFiles(
  manifestDir: string,
  patterns: string[],
  opts: { applyDefaultIgnore?: boolean } = {},
): string[] {
  if (patterns.length === 0) return [];

  const select = ignore().add(patterns);
  const deny = opts.applyDefaultIgnore === false ? null : ignore().add([...DEFAULT_IGNORE]);

  // Note: DEFAULT_IGNORE is a post-filter, not a walk pruner — the recursive
  // readdir still enumerates `node_modules/` etc. before they're filtered out.
  // Publish is not a hot path, so the full walk is acceptable.
  const entries = fs.readdirSync(manifestDir, { recursive: true, withFileTypes: true });
  const realManifestDir = fs.realpathSync(manifestDir) + path.sep;

  const selected: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(manifestDir, abs).split(path.sep).join("/");
    if (!select.ignores(rel)) continue;
    if (deny?.ignores(rel)) continue;

    const real = fs.realpathSync(abs);
    if (!real.startsWith(realManifestDir)) {
      throw new Error(
        `files pattern selected '${rel}', which resolves outside the module directory. ` +
          `Bundling files from outside the module root is not allowed.`,
      );
    }
    selected.push(rel);
  }

  selected.sort();
  return selected;
}

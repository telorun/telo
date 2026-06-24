import { GLOB_PRUNE_DIRS, selectByPatterns, type SelectOptions } from "@telorun/glob";
import type { DirEntry } from "../model";

// Directory basenames skipped at any depth during workspace scan.
export const SCAN_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  "__fixtures__",
]);

// Path suffixes (relative to workspace root) skipped during scan. Used for
// compound paths that would be too broad as a bare basename — e.g. matching
// "build" alone would also skip unrelated build output in other subtrees.
export const SCAN_EXCLUDED_RELATIVE_PATHS: readonly string[] = [
  "pages/build", // Docusaurus output
];

// ---------------------------------------------------------------------------
// Path utilities (avoids a browser polyfill dependency)
// ---------------------------------------------------------------------------

export function pathDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : i === 0 ? "/" : p.slice(0, i);
}

export function pathBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function pathExtname(p: string): string {
  const base = pathBasename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function pathJoin(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

export function pathResolve(base: string, rel: string): string {
  if (rel.startsWith("/")) return normalizePath(rel);
  const combined = pathDirname(base) + "/" + rel;
  return normalizePath(combined);
}

export function pathRelative(from: string, to: string): string {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const rel = [...Array(ups).fill(".."), ...toParts.slice(i)].join("/");
  return rel || ".";
}

export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/");
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === "..") stack.pop();
    else if (seg !== "" && seg !== ".") stack.push(seg);
  }
  return (abs ? "/" : "") + stack.join("/");
}

// ---------------------------------------------------------------------------
// Glob matching — the walk lives here; matching delegates to the single
// Telo-glob matcher in @telorun/glob (shared with the kernel, CLI publish,
// and test discovery). No second glob implementation in the editor.
// ---------------------------------------------------------------------------

/** True when a pattern contains any glob metacharacter. */
export function hasGlobChars(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Recursively collects all file paths under a directory via a one-level
 *  `listDir`. `GLOB_PRUNE_DIRS` (node_modules/.git/.telo) are pruned for
 *  performance — a strict subset of the deny set, so results are unchanged.
 *  `dist`/`__fixtures__` are NOT pruned (a `files: dist/**` or
 *  `include: __fixtures__/*.yaml` must still resolve). Returned paths are
 *  absolute (joined with the input dir). */
export async function walkFilesRecursive(
  dir: string,
  listDir: (dir: string) => Promise<DirEntry[]>,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = pathJoin(current, entry.name);
      if (entry.isDirectory) {
        if (GLOB_PRUNE_DIRS.has(entry.name)) continue;
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Path/string utilities
// ---------------------------------------------------------------------------

export function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function toRelativeSource(fromPath: string, toPath: string): string {
  const fromDir = pathDirname(fromPath);
  const toDir = pathDirname(toPath);
  const rel = pathRelative(fromDir, toDir);
  return rel === "." ? "." : rel.startsWith(".") ? rel : "./" + rel;
}

/** Generic glob expander shared by every browser-side caller (the three
 *  adapters' `include:` resolution and the run bundle's `files:` selection).
 *  Walks `base`'s directory via `listDir`, then matches with the shared
 *  Telo-glob matcher. `opts` forwards to `selectByPatterns` — `include:` passes
 *  `{ applyDefaultIgnore: false }` to reach co-located partials (the hard deny
 *  tier still bars `node_modules`/`.git`/`.telo`); `files:` keeps the soft deny
 *  pass too. Returns matching absolute paths. */
export async function expandGlobViaList(
  base: string,
  patterns: string[],
  listDir: (dir: string) => Promise<DirEntry[]>,
  opts: SelectOptions = {},
): Promise<string[]> {
  const baseDir = pathDirname(base);
  const relToAbs = new Map<string, string>();
  for (const abs of await walkFilesRecursive(baseDir, listDir)) {
    relToAbs.set(pathRelative(baseDir, abs), abs);
  }
  return selectByPatterns([...relToAbs.keys()], patterns, opts).map((rel) => relToAbs.get(rel)!);
}

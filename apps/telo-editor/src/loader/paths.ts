import type { DirEntry, WorkspaceAdapter } from "../model";

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
// Glob matching (browser-safe; no minimatch dependency)
// ---------------------------------------------------------------------------

/** Converts a glob pattern to a regex. Handles `*` (any chars except `/`),
 *  `**` (any chars including `/`), and `?` (single char except `/`). Brace
 *  and character-class expansion are intentionally unsupported — they are not
 *  required by current include patterns and would bloat this function. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("\\^$+.()=!|:{}[]".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when a pattern contains any glob metacharacter. */
export function hasGlobChars(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Recursively collects all file paths under a directory via a
 *  WorkspaceAdapter's `listDir`. Directories listed in SCAN_EXCLUDED_NAMES
 *  are skipped. Returned paths are absolute (joined with the input dir). */
export async function listAllFilesRecursive(
  dir: string,
  adapter: WorkspaceAdapter,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await adapter.listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SCAN_EXCLUDED_NAMES.has(entry.name)) continue;
      const full = pathJoin(current, entry.name);
      if (entry.isDirectory) {
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

/** Generic glob expander. Given a `base` source (an owner telo.yaml path),
 *  expands each pattern relative to the base's directory and returns matching
 *  absolute file paths. Used by all three browser-side adapters to avoid
 *  duplicating the walk-and-match logic three times. `listFiles` is the
 *  adapter-specific piece that enumerates the directory tree. */
export async function expandGlobViaList(
  base: string,
  patterns: string[],
  listFiles: (dir: string) => Promise<string[]>,
): Promise<string[]> {
  const baseDir = pathDirname(base);
  const allFiles = await listFiles(baseDir);
  const normalizedPatterns = patterns.map((p) => p.replace(/^\.\//, ""));
  const regexps = normalizedPatterns.map((p) =>
    hasGlobChars(p) ? globToRegExp(p) : null,
  );

  const matched = new Set<string>();
  for (const file of allFiles) {
    const rel = pathRelative(baseDir, file);
    for (let i = 0; i < normalizedPatterns.length; i++) {
      const re = regexps[i];
      if (re) {
        if (re.test(rel)) matched.add(file);
      } else if (rel === normalizedPatterns[i]) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort();
}

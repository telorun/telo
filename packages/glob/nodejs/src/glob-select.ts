/**
 * The single glob-matching engine for the whole monorepo. Every place that
 * resolves a `.gitignore`-style pattern set against a list of paths — `files:`
 * bundling (`telo publish`, the editor run bundle), `include:` expansion
 * (kernel + editor manifest sources), and test discovery (`modules/test`) —
 * routes through {@link selectByPatterns}. There is no second engine.
 *
 * The matcher is a deliberately small, dependency-free implementation of the
 * **Telo glob** subset specified in `packages/glob/conformance/README.md` and
 * pinned by `packages/glob/conformance/glob.json`. It is a *subset* of gitignore,
 * chosen so any runtime (Node today; Rust / Go later) can reimplement it
 * identically without inheriting one library's quirks — the conformance fixtures
 * are the cross-language contract. See that spec for the exact grammar; the code
 * here implements it, the spec defines it.
 *
 * Callers own only the *walk* (Node `fs` vs. a browser `listDir`); the matching
 * is shared so behaviour is identical across runtimes.
 */

/**
 * Hard deny tier: never ships and is **never opt-out-able**, even when
 * `applyDefaultIgnore: false`. These are the manifest cache (recursing it would
 * loop), the VCS dir, and vendored deps — there is no legitimate `files:` or
 * `include:` that should reach into them. This is what lets `include:` opt out
 * of the soft tier (to reach co-located partials) without ever pulling in
 * `node_modules` or the `.telo` cache.
 */
export const HARD_IGNORE: readonly string[] = ["node_modules/", ".git/", ".telo/"];

/**
 * Soft deny tier: subtracted after the allowlist by default, skipped when
 * `applyDefaultIgnore: false`. Controller-bundle output that an author's
 * patterns shouldn't ship by accident, but which `include:` may legitimately
 * opt out of.
 */
export const DEFAULT_IGNORE: readonly string[] = [".telobundle.*"];

/**
 * Directories a walking caller may prune mid-descent purely for performance.
 * Mirrors the directory rules in {@link HARD_IGNORE}, so pruning them changes no
 * result — it only avoids descending trees the hard deny tier discards anyway.
 * Full-walk callers (Node `fs.readdir` recursive) ignore this and rely on the
 * deny tier alone. `dist`, `__fixtures__`, etc. are intentionally absent: an
 * `include:` of `__fixtures__/x.yaml` or a `files:` of `dist/**` must still
 * resolve.
 */
export const GLOB_PRUNE_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".telo"]);

export interface SelectOptions {
  /** Subtract the soft {@link DEFAULT_IGNORE} tier after the allowlist.
   *  Default `true`. The hard {@link HARD_IGNORE} tier is always applied. */
  applyDefaultIgnore?: boolean;
  /** Additional `.gitignore`-style patterns to carve out after the allowlist
   *  (e.g. a test suite's `exclude:` list). */
  exclude?: string[];
}

interface CompiledPattern {
  negated: boolean;
  re: RegExp;
}

const REGEX_META = /[.^$+|()[\]{}\\]/;

function normalize(patterns: string[]): string[] {
  return patterns.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
}

/** Compile one glob body to an anchored regex per the Telo glob grammar. */
function bodyToRegExp(glob: string, anchored: boolean): RegExp {
  let re = anchored ? "" : "(?:.*/)?";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          re += "(?:.*/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += REGEX_META.test(c) ? "\\" + c : c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

function compile(pattern: string): CompiledPattern {
  let body = pattern;
  let negated = false;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  }
  body = body.replace(/^\.\//, "");
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  }
  // Anchoring is decided from the original body: a sole trailing slash does not
  // anchor (so `node_modules/` stays floating), any other internal slash does.
  const withoutTrailing = body.endsWith("/") ? body.slice(0, -1) : body;
  anchored = anchored || withoutTrailing.includes("/");
  // A trailing-slash directory pattern selects the directory's contents.
  if (body.endsWith("/")) body += "**";
  return { negated, re: bodyToRegExp(body, anchored) };
}

/** Last-match-wins: the final pattern that matches `rel` decides it. Deny /
 *  exclude lists carry no negation, so this reduces to "any match" for them. */
function decide(rel: string, compiled: CompiledPattern[]): boolean {
  let selected = false;
  for (const { negated, re } of compiled) {
    if (re.test(rel)) selected = !negated;
  }
  return selected;
}

/**
 * Select the relative POSIX paths in `relPaths` that `patterns` match under the
 * Telo glob grammar (positive patterns opt in, `!` patterns carve out,
 * last-match-wins). {@link HARD_IGNORE} is always subtracted; {@link
 * DEFAULT_IGNORE} and any `opts.exclude` are subtracted after the allowlist and
 * cannot be re-included. Returns a sorted copy; never mutates the input.
 *
 * Paths must be relative and POSIX-separated (no leading `/`).
 */
export function selectByPatterns(
  relPaths: string[],
  patterns: string[],
  opts: SelectOptions = {},
): string[] {
  if (patterns.length === 0) return [];

  const select = normalize(patterns).map(compile);
  const hard = HARD_IGNORE.map(compile);
  const soft = opts.applyDefaultIgnore === false ? [] : DEFAULT_IGNORE.map(compile);
  const exclude = opts.exclude?.length ? normalize(opts.exclude).map(compile) : [];

  const matched = relPaths.filter((rel) => {
    if (!rel || !decide(rel, select)) return false;
    if (decide(rel, hard)) return false;
    if (soft.length && decide(rel, soft)) return false;
    if (exclude.length && decide(rel, exclude)) return false;
    return true;
  });
  matched.sort();
  return matched;
}

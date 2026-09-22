/**
 * `telo changed` — did any file this entry point depends on change since a git
 * ref?
 *
 * A CI primitive for gating an expensive job (a live-model suite, an e2e stack)
 * on whether the paths it actually depends on moved, instead of paying for it
 * on every push.
 *
 * Each argument is a module entry point — `./apps/authoring-agent`,
 * `./modules/assert`, `./modules/assert/telo.yaml` — or, when it is neither,
 * a plain glob pattern matched literally (`.github/workflows/e2e.yml`). A
 * module entry point is spelled `telo.yaml`, exactly as it is everywhere else
 * in the repo: a manifest under any other name is matched literally, because
 * anchoring a module's whole DIRECTORY is only right for a directory the
 * module owns. `examples/test-suite-live.yaml` parses as an application and
 * owns nothing — taking it as an entry point anchored `examples/**`, so a gate
 * meant to watch two examples fired on every one of them.
 *
 * Patterns and the diff are both spelled relative to the REPOSITORY ROOT,
 * which is what `git diff --name-only` reports against regardless of where it
 * is invoked. Spelling patterns against the working directory instead made the
 * answer depend on where the command ran from, and wrongly in the skip
 * direction — from `apps/`, `./hub` became `hub/**` and matched none of the
 * `apps/hub/…` paths in the diff. A module entry point aligns this with `telo
 * release`'s own notion of "affected": release propagates a version bump along
 * a module's **relative** `imports:` edges, because a relative sibling's source
 * is inlined into the dependent's published artifact
 * (`analyzer/nodejs/src/release/release-plan.ts`, `propagateToFixedPoint`).
 * This walks the identical edges — the same `importSourceRefs` /
 * `resolveSiblingManifest` pair the payload builder reads them through — but
 * stops at the manifest text: no payload is built, no controller is bundled,
 * so a manifest with a hundred dependents costs a hundred small YAML parses
 * rather than a hundred builds. A remote (`oci://`) import is deliberately not
 * followed: it is pinned by digest, so a local source change cannot reach it
 * until published and re-pinned.
 *
 * The diff is the same three-dot merge-base diff `telo release`'s evidence
 * gathering takes (`git diff --name-only <base>...HEAD`), and every resulting
 * pattern is matched with the one glob engine the rest of the CLI already
 * reads `files:` / `include:` / `ignore:` through (`@telorun/glob`).
 */

import { selectByPatterns } from "@telorun/glob";
import { defaultCustomTags } from "@telorun/templating";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments, type Document } from "yaml";
import type { Argv } from "yargs";
import { resolveSiblingManifest } from "../bundle/module-payload.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import { findModuleDoc, importSourceRefs } from "./manifest-imports.js";

const MANIFEST_FILENAME = "telo.yaml";

interface ChangedArgv {
  paths: string[];
  base: string;
  failOpen: boolean;
}

/** The repository the invocation directory sits in, or `undefined` outside one
 *  — in which case the diff below cannot be taken either, so the fail-open
 *  path answers. */
function repositoryRoot(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The files touched since `base`, relative to the repository root —
 * `undefined` when the diff could not be taken at all (no merge base, `base`
 * not fetched locally, not a git repository), which must never be conflated
 * with "diffed cleanly and found nothing".
 */
function diffedFiles(base: string): string[] | undefined {
  try {
    const diff = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return diff
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/** The module doc at `manifestPath`, or `undefined` for anything that is not a
 *  parseable Telo module — a non-YAML file, or YAML that carries no `kind:`
 *  a Telo application/library declares (a GitHub Actions workflow, say). */
function moduleDocAt(manifestPath: string): Document | undefined {
  try {
    const docs = parseAllDocuments(fs.readFileSync(manifestPath, "utf8"), {
      customTags: defaultCustomTags(),
    });
    return findModuleDoc(docs);
  } catch {
    return undefined;
  }
}

/** Add `manifestPath`'s own directory, then walk its **relative** `imports:`
 *  edges transitively, adding each sibling's directory in turn. `visited`
 *  guards a cycle and a diamond (two entries sharing one dependency) alike, so
 *  each manifest is parsed once regardless of how many paths reach it. */
function collectDependencyDirs(manifestPath: string, dirs: Set<string>, visited: Set<string>): void {
  const key = path.resolve(manifestPath);
  if (visited.has(key)) return;
  visited.add(key);
  dirs.add(path.dirname(key));

  const moduleDoc = moduleDocAt(key);
  if (!moduleDoc) return;

  for (const entry of importSourceRefs(moduleDoc)) {
    // A remote import is pinned by digest — its source is not in this diff at
    // all until it is published and the pin is bumped, which is a separate
    // commit `telo changed` sees on its own terms.
    if (!entry.source.startsWith(".") && !entry.source.startsWith("/")) continue;
    const sibling = resolveSiblingManifest(path.dirname(key), entry.source);
    collectDependencyDirs(sibling, dirs, visited);
  }
}

/** A path spelled the way the diff spells it: relative to the repository root,
 *  with forward slashes. A path outside the repository keeps its `..` prefix
 *  and so matches nothing, which is the truth — the diff cannot name it. */
function asRootRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function asPattern(root: string, dir: string): string {
  const relative = asRootRelative(root, dir);
  return relative === "" ? "**" : `${relative}/**`;
}

/**
 * One CLI argument, resolved to the glob pattern(s) it stands for:
 *
 * - A `telo.yaml` (`./modules/assert/telo.yaml`) or a directory holding one
 *   (`./modules/assert`) — its own directory plus every relatively-imported
 *   sibling's, transitively.
 * - A directory with no `telo.yaml` — just that directory.
 * - Anything else — a manifest under another name, an ordinary file, or a path
 *   that does not exist on disk at all (a glob, or a deleted file) — the
 *   argument itself, matched literally against the diff.
 */
function patternsFor(root: string, input: string): string[] {
  const resolved = path.resolve(input);
  const literal = [asRootRelative(root, resolved)];
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return literal;
  }

  if (stat.isDirectory()) {
    const manifestPath = path.join(resolved, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) return [asPattern(root, resolved)];
    const dirs = new Set<string>();
    collectDependencyDirs(manifestPath, dirs, new Set());
    return [...dirs].map((dir) => asPattern(root, dir));
  }

  if (path.basename(resolved) !== MANIFEST_FILENAME || !moduleDocAt(resolved)) return literal;
  const dirs = new Set<string>();
  collectDependencyDirs(resolved, dirs, new Set());
  return [...dirs].map((dir) => asPattern(root, dir));
}

/** Every argument's patterns, against a repository rooted at `root`. Exported
 *  for the test that pins what a gate actually watches: an argument's meaning
 *  is the whole behaviour here, and it is invisible in an exit code. */
export function resolvePatterns(root: string, inputs: string[]): string[] {
  return inputs.flatMap((input) => patternsFor(root, input));
}

async function changed(argv: ChangedArgv): Promise<void> {
  const root = repositoryRoot();
  const patterns = root === undefined ? [] : resolvePatterns(root, argv.paths);
  const files = root === undefined ? undefined : diffedFiles(argv.base);

  if (files === undefined) {
    outErrLine(
      `Could not diff against '${argv.base}' — ${argv.failOpen ? "reporting 'changed'" : "reporting 'unchanged'"}.`,
    );
    outLine(String(argv.failOpen));
    outEmit({ changed: argv.failOpen, base: argv.base, patterns, diffed: false });
    if (!argv.failOpen) process.exitCode = 1;
    return;
  }

  const matched = selectByPatterns(files, patterns);
  const result = matched.length > 0;
  outLine(String(result));
  outEmit({ changed: result, base: argv.base, patterns, diffed: true, matched });
  if (!result) process.exitCode = 1;
}

export function changedCommand(yargs: Argv): Argv {
  return yargs.command(
    "changed <paths..>",
    "Exit 0 when a module entry point's dependency graph, or a plain path, changed since a git ref, 1 otherwise",
    (y) =>
      y
        .positional("paths", {
          describe:
            "A module entry point (a directory holding telo.yaml, or a telo.yaml itself) — walked " +
            "transitively through its relative imports — or, for anything else, a Telo-glob pattern " +
            "matched literally against the diff's relative paths",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("base", {
          type: "string",
          default: "origin/main",
          describe: "Git ref the diff is taken against (a three-dot diff: base...HEAD)",
        })
        .option("fail-open", {
          type: "boolean",
          default: true,
          describe:
            "When the diff cannot be taken (no merge base, base ref not fetched, not a git repository), report 'changed' rather than 'unchanged'",
        }),
    async (argv) => {
      await changed(argv as unknown as ChangedArgv);
    },
  );
}


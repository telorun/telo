/**
 * `telo changed <globs..>` — which of these files are affected by what changed
 * since a git ref?
 *
 * A CI primitive for running only what a change can reach: the module test
 * suites a pull request touches, or an expensive job (a live-model suite, an
 * e2e stack) gated on its own entry point.
 *
 * Each argument is a Telo-glob pattern (`!` carves out), resolved against the
 * working directory and expanded over the repository's files — tracked and
 * untracked, minus what `.gitignore` excludes. Every matched file is judged on
 * its own, by what it DEPENDS on:
 *
 * - A `telo.yaml` owns its whole directory; any other Telo manifest (a test, a
 *   suite) owns only itself and the `__fixtures__/` beside it — anchoring its
 *   directory would make `examples/test-suite-live.yaml` claim every example.
 * - Both add, transitively, every module they import by a **relative** path,
 *   every other Telo manifest a relative path in them names (an
 *   `Assert.Manifest` / `App.Instance` `source:`), their `include:` partials and
 *   the files their `!include-*` / `!module-path` tags claim.
 * - Any other file owns only itself.
 *
 * Not followed: a `pkg:cargo` controller's Cargo path dependencies.
 *
 * A module's controller sources inline their `workspace:` dependencies into its
 * bundle, and no manifest edge names those, so the closure also follows the
 * `dependencies` of the `package.json` nearest each controller or library
 * entry's `local_path`, transitively. Without that, a change to a shared
 * TypeScript package would be reported as reaching nothing.
 *
 * The import walk is the one `telo release` propagates a version bump along —
 * the same `importSourceRefs` / `resolveSiblingManifest` pair the payload
 * builder reads — but it stops at the manifest text: nothing is built. A remote
 * (`oci://`) import is not followed: it is pinned by digest, so a local source
 * change cannot reach it until published and re-pinned.
 *
 * Everything is spelled relative to the REPOSITORY ROOT, which is what `git
 * diff --name-only` reports against wherever it runs. The diff is the
 * three-dot merge-base diff `telo release` takes (`<base>...HEAD`). When it
 * cannot be taken, every matched file is reported as affected: an answer that
 * skips work must be one the diff actually gave.
 */

import { collectModuleFileClaims } from "@telorun/analyzer";
import { selectByPatterns } from "@telorun/glob";
import { defaultCustomTags } from "@telorun/templating";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSeq, parseAllDocuments, type Document } from "yaml";
import type { Argv } from "yargs";
import { resolveSiblingManifest } from "../bundle/module-payload.js";
import { outEmit, outErrLine, outLine } from "../output.js";
import { findModuleDoc, importSourceRefs } from "./manifest-imports.js";

const MANIFEST_FILENAME = "telo.yaml";
const PACKAGE_FILENAME = "package.json";
const FIXTURES_DIRNAME = "__fixtures__";
const WORKSPACE_PROTOCOL = "workspace:";

interface ChangedArgv {
  globs: string[];
  base: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * The files touched since `base` — `undefined` when the diff could not be
 * taken (no merge base, `base` not fetched locally), which must never be
 * conflated with "diffed cleanly and found nothing".
 */
function diffedFiles(root: string, base: string): string[] | undefined {
  try {
    return nulSeparated(git(root, ["diff", "--name-only", "-z", `${base}...HEAD`]));
  } catch {
    return undefined;
  }
}

function asRootRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/** A root-relative path as a glob anchored at the root — a slash-free pattern
 *  would otherwise float and match that name in every directory. */
function anchored(relative: string): string {
  return `/${relative}`;
}

function directoryPattern(root: string, dir: string): string {
  const relative = asRootRelative(root, dir);
  return relative === "" ? "/**" : anchored(`${relative}/**`);
}

interface ManifestEdges {
  /** Absolute paths of the manifests this one imports relatively, and of every
   *  other Telo manifest a relative path in it names — an `Assert.Manifest` or
   *  `App.Instance` `source:` runs one without importing it. */
  manifests: string[];
  /** Absolute directories of the packages its controller sources are built from. */
  packages: string[];
  /** Root-anchored patterns of the files it names: its `include:` partials and
   *  what its `!include-*` / `!module-path` tags claim. */
  files: string[];
}

/**
 * What a set of repository files depends on. Parses are memoized, so judging
 * hundreds of test manifests that share a few modules costs each module one
 * parse.
 */
export class ChangeScope {
  private readonly manifestEdges = new Map<string, ManifestEdges | undefined>();
  private readonly moduleDocs = new Map<string, Document | undefined>();
  private readonly packageEdges = new Map<string, string[]>();
  private workspacePackages: Map<string, string> | undefined;

  /**
   * @param root  the repository root
   * @param files every repository file, root-relative and POSIX-separated
   */
  constructor(
    private readonly root: string,
    private readonly files: readonly string[],
  ) {}

  /** The files `globs` select, root-relative. Each glob is resolved against
   *  `cwd`; one selecting nothing is reported, since it is usually a typo. */
  expand(globs: readonly string[], cwd: string): string[] {
    const patterns = globs.map((glob) => {
      const negated = glob.startsWith("!");
      const body = negated ? glob.slice(1) : glob;
      return (negated ? "!" : "") + anchored(asRootRelative(this.root, path.resolve(cwd, body)));
    });
    for (const [index, pattern] of patterns.entries()) {
      if (pattern.startsWith("!")) continue;
      if (selectByPatterns([...this.files], [pattern]).length === 0) {
        outErrLine(`'${globs[index]}' matched no files.`);
      }
    }
    return selectByPatterns([...this.files], patterns);
  }

  /** The root-anchored patterns a change must match to affect `entry`. */
  coverage(entry: string): string[] {
    const absolute = path.resolve(this.root, entry);
    if (!this.moduleDoc(absolute)) return [anchored(entry)];

    const patterns = new Set<string>();
    if (path.basename(absolute) !== MANIFEST_FILENAME) {
      patterns.add(directoryPattern(this.root, path.join(path.dirname(absolute), FIXTURES_DIRNAME)));
    }
    this.collectManifest(absolute, patterns, new Set(), new Set());
    return [...patterns];
  }

  /** Whether any of `changed` falls within `entry`'s coverage. */
  affects(entry: string, changed: readonly string[]): boolean {
    return selectByPatterns([...changed], this.coverage(entry)).length > 0;
  }

  /** A `telo.yaml` owns its directory; any other manifest owns itself. Both add
   *  every manifest, package and file they name. */
  private collectManifest(
    manifest: string,
    patterns: Set<string>,
    manifests: Set<string>,
    packages: Set<string>,
  ): void {
    if (manifests.has(manifest)) return;
    manifests.add(manifest);
    patterns.add(
      path.basename(manifest) === MANIFEST_FILENAME
        ? directoryPattern(this.root, path.dirname(manifest))
        : anchored(asRootRelative(this.root, manifest)),
    );
    const edges = this.edgesOf(manifest);
    if (!edges) return;
    for (const named of edges.manifests) this.collectManifest(named, patterns, manifests, packages);
    for (const dir of edges.packages) this.collectPackage(dir, patterns, packages);
    for (const file of edges.files) patterns.add(file);
  }

  private collectPackage(dir: string, patterns: Set<string>, packages: Set<string>): void {
    if (packages.has(dir)) return;
    packages.add(dir);
    patterns.add(directoryPattern(this.root, dir));
    for (const dependency of this.packageDependencies(dir)) {
      this.collectPackage(dependency, patterns, packages);
    }
  }

  /** What a manifest names, or `undefined` for a file that is not a Telo module. */
  private edgesOf(manifest: string): ManifestEdges | undefined {
    if (this.manifestEdges.has(manifest)) return this.manifestEdges.get(manifest);
    const moduleDoc = this.moduleDoc(manifest);
    let edges: ManifestEdges | undefined;
    if (moduleDoc) {
      const dir = path.dirname(manifest);
      const text = fs.readFileSync(manifest, "utf8");
      const named = new Set<string>();
      for (const entry of importSourceRefs(moduleDoc)) {
        if (entry.source.startsWith(".") || entry.source.startsWith("/")) {
          named.add(resolveSiblingManifest(dir, entry.source));
        }
      }
      for (const candidate of relativePathsIn(text)) {
        const target = this.namedManifest(dir, candidate);
        if (target && target !== manifest) named.add(target);
      }

      const packages = new Set<string>();
      const files = new Set<string>();
      for (const claim of collectModuleFileClaims(text)) {
        if (claim.role === "assets") {
          const relative = asRootRelative(this.root, path.resolve(dir, claim.path));
          files.add(anchored(relative));
          files.add(anchored(`${relative}/**`));
          continue;
        }
        if (!claim.localPath) continue;
        const packageDir = nearestPackageDir(dir, claim.localPath);
        if (packageDir) packages.add(packageDir);
      }
      const include = moduleDoc.get("include");
      const partials = isSeq(include) ? include.toJSON() : [];
      for (const glob of Array.isArray(partials) ? partials : []) {
        if (typeof glob === "string") {
          files.add(anchored(asRootRelative(this.root, path.resolve(dir, glob))));
        }
      }
      edges = { manifests: [...named], packages: [...packages], files: [...files] };
    }
    this.manifestEdges.set(manifest, edges);
    return edges;
  }

  /** `moduleDocAt`, parsed once per file however many manifests name it. */
  private moduleDoc(file: string): Document | undefined {
    if (!this.moduleDocs.has(file)) this.moduleDocs.set(file, moduleDocAt(file));
    return this.moduleDocs.get(file);
  }

  /** The Telo manifest a relative path names — a directory holding a
   *  `telo.yaml`, or a YAML file carrying a module doc — or `undefined`. */
  private namedManifest(dir: string, relative: string): string | undefined {
    const target = path.resolve(dir, relative);
    if (!fs.existsSync(target)) return undefined;
    if (fs.statSync(target).isDirectory()) {
      const manifest = path.join(target, MANIFEST_FILENAME);
      return fs.existsSync(manifest) && this.moduleDoc(manifest) ? manifest : undefined;
    }
    return this.moduleDoc(target) ? target : undefined;
  }

  /** The workspace packages `dir`'s `package.json` depends on, as directories. */
  private packageDependencies(dir: string): string[] {
    const memo = this.packageEdges.get(dir);
    if (memo) return memo;
    const manifest = readPackageJson(path.join(dir, PACKAGE_FILENAME));
    const dependencies: string[] = [];
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof spec !== "string" || !spec.startsWith(WORKSPACE_PROTOCOL)) continue;
      const target = this.workspacePackageDirs().get(name);
      if (!target) {
        throw new Error(
          `${asRootRelative(this.root, path.join(dir, PACKAGE_FILENAME))} depends on '${name}' ` +
            `through the workspace protocol, but no package in the repository is named '${name}'.`,
        );
      }
      dependencies.push(target);
    }
    this.packageEdges.set(dir, dependencies);
    return dependencies;
  }

  private workspacePackageDirs(): Map<string, string> {
    if (this.workspacePackages) return this.workspacePackages;
    const byName = new Map<string, string>();
    for (const file of this.files) {
      if (file !== PACKAGE_FILENAME && !file.endsWith(`/${PACKAGE_FILENAME}`)) continue;
      const absolute = path.resolve(this.root, file);
      const name = readPackageJson(absolute).name;
      if (typeof name === "string" && !byName.has(name)) byName.set(name, path.dirname(absolute));
    }
    this.workspacePackages = byName;
    return byName;
  }
}

/** The module doc at `manifestPath`, or `undefined` for anything that is not a
 *  parseable Telo module — a non-YAML file, or YAML that carries no `kind:`
 *  a Telo application/library declares (a GitHub Actions workflow, say). */
function moduleDocAt(manifestPath: string): Document | undefined {
  if (!/\.ya?ml$/.test(manifestPath)) return undefined;
  try {
    const docs = parseAllDocuments(fs.readFileSync(manifestPath, "utf8"), {
      customTags: defaultCustomTags(),
    });
    return findModuleDoc(docs);
  } catch {
    return undefined;
  }
}

/** Every scalar in the file that is written as a relative path (`./…`, `../…`). */
function relativePathsIn(text: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.startsWith("./") || node.startsWith("../")) out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  for (const doc of parseAllDocuments(text, { customTags: defaultCustomTags() })) visit(doc.toJSON());
  return out;
}

interface PackageJson {
  name?: unknown;
  dependencies?: Record<string, unknown>;
}

function readPackageJson(file: string): PackageJson {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
}

/** The directory of the `package.json` nearest a module's `local_path` source,
 *  searched no higher than the module's own directory. */
function nearestPackageDir(moduleDir: string, localPath: string): string | undefined {
  const source = path.resolve(moduleDir, localPath);
  let dir = fs.existsSync(source) && fs.statSync(source).isDirectory() ? source : path.dirname(source);
  for (;;) {
    const relative = path.relative(moduleDir, dir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    if (fs.existsSync(path.join(dir, PACKAGE_FILENAME))) return dir;
    if (relative === "") return undefined;
    dir = path.dirname(dir);
  }
}

async function changed(argv: ChangedArgv): Promise<void> {
  let root: string;
  try {
    root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("telo changed must run inside a git repository.");
  }
  const files = nulSeparated(
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  );
  const scope = new ChangeScope(root, files);
  const entries = scope.expand(argv.globs, process.cwd());
  const diff = diffedFiles(root, argv.base);

  if (diff === undefined) {
    outErrLine(`Could not diff against '${argv.base}' — reporting every matched file as affected.`);
  }
  const affected: string[] = [];
  const unaffected: string[] = [];
  for (const entry of entries) {
    (diff === undefined || scope.affects(entry, diff) ? affected : unaffected).push(entry);
  }

  for (const entry of affected) outLine(entry);
  outEmit({ base: argv.base, diffed: diff !== undefined, affected, unaffected });
}

export function changedCommand(yargs: Argv): Argv {
  return yargs.command(
    "changed <globs..>",
    "List the files matching the globs that are affected by changes since a git ref",
    (y) =>
      y
        .positional("globs", {
          describe:
            "Telo-glob patterns (a leading '!' excludes) resolved against the working directory. " +
            "A telo.yaml is affected through its directory and its relative imports, any other " +
            "Telo manifest through itself, its __fixtures__ and its relative imports, and any " +
            "other file through itself",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("base", {
          type: "string",
          default: "origin/main",
          describe: "Git ref the diff is taken against (a three-dot diff: base...HEAD)",
        }),
    async (argv) => {
      await changed(argv as unknown as ChangedArgv);
    },
  );
}

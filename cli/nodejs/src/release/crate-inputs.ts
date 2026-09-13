/**
 * The build inputs of a crate-built source, as one digest.
 *
 * A source whose files are prebuilt from a crate in this repository names that
 * crate (`build: { cargo: <dir> }`), and `telo release stage --pin` records what
 * built them (`build.inputs`): the committed files of the crate and of every
 * path crate it reaches transitively — through a path dependency or a `[patch]`
 * entry — the `Cargo.lock` packages those crates reach, the cargo configuration
 * and toolchain files that apply where the crate is built, and what the
 * workspace root's `Cargo.toml` passes down. A lock entry nothing here depends
 * on is not an input, so an unrelated crate's new dependency trips no source.
 * `telo release check` recomputes the same digest and fails when it moved, so a
 * module never ships binaries older than the code they were built from — and an
 * edit to a crate every controller depends on (the SDK, the controller ABI)
 * trips every source built on it.
 *
 * Files are what git tracks, read from the working tree: build output, ignored
 * files and a scratch file nobody added are not inputs, wherever they sit.
 * Cargo is never invoked, so the check needs no toolchain and builds nothing.
 */

import {
  isModuleKind,
  readModuleSources,
  sha256Base64Url,
  type ModuleSource,
} from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { parseCargoToml, type TomlTable, type TomlValue } from "./cargo-toml.js";
import type { DiscoveredModule } from "./workspace.js";

/** Files that configure a build from the directory they sit in downward. */
const BUILD_CONFIG_FILES = [
  ".cargo/config",
  ".cargo/config.toml",
  "rust-toolchain",
  "rust-toolchain.toml",
];

/** What the workspace root's `Cargo.toml` passes down to every member's build. */
const INHERITED_ROOT_KEYS: ReadonlyArray<readonly string[]> = [
  ["patch"],
  ["replace"],
  ["profile"],
  ["workspace", "resolver"],
  ["workspace", "package"],
  ["workspace", "lints"],
];

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readManifest(dir: string): TomlTable {
  const file = path.join(dir, "Cargo.toml");
  if (!fs.existsSync(file)) throw new Error(`'${dir}' holds no Cargo.toml, so it is not a crate.`);
  return parseCargoToml(fs.readFileSync(file, "utf8"), file);
}

/** The directory of the workspace governing `crateDir` — the one whose
 *  `Cargo.lock` fixed its registry dependencies — resolved as cargo does. */
function workspaceRootOf(crateDir: string, manifest: TomlTable): { dir: string; manifest: TomlTable } {
  if (isTable(manifest.workspace)) return { dir: crateDir, manifest };
  const pkg = manifest.package;
  if (isTable(pkg) && typeof pkg.workspace === "string") {
    const dir = path.resolve(crateDir, pkg.workspace);
    return { dir, manifest: readManifest(dir) };
  }
  for (let dir = path.dirname(crateDir); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) {
      const candidate = readManifest(dir);
      const workspace = candidate.workspace;
      if (isTable(workspace)) {
        const relative = path.relative(dir, crateDir).split(path.sep).join("/");
        const excluded = Array.isArray(workspace.exclude) && workspace.exclude.some(
          (entry) => typeof entry === "string" && (relative === entry.replace(/\/+$/, "") || relative.startsWith(`${entry.replace(/\/+$/, "")}/`)),
        );
        return excluded ? { dir: crateDir, manifest } : { dir, manifest: candidate };
      }
    }
    if (path.dirname(dir) === dir) return { dir: crateDir, manifest };
  }
}

/** The directories of the path dependencies one crate's manifest declares — in
 *  `[dependencies]`, `[build-dependencies]` and their per-target forms, the ones
 *  that link into the build — with `workspace = true` resolved against the
 *  workspace root's `[workspace.dependencies]`. */
function pathDependencies(
  crateDir: string,
  manifest: TomlTable,
  root: { dir: string; manifest: TomlTable },
  inheritedNames: Set<string>,
): string[] {
  const tables: TomlValue[] = [manifest.dependencies, manifest["build-dependencies"]];
  if (isTable(manifest.target)) {
    for (const target of Object.values(manifest.target)) {
      if (isTable(target)) tables.push(target.dependencies, target["build-dependencies"]);
    }
  }
  const workspaceDeps = isTable(root.manifest.workspace) ? root.manifest.workspace.dependencies : undefined;
  const out: string[] = [];
  for (const table of tables) {
    if (!isTable(table)) continue;
    for (const [name, spec] of Object.entries(table)) {
      if (!isTable(spec)) continue;
      if (typeof spec.path === "string") {
        out.push(path.resolve(crateDir, spec.path));
      } else if (spec.workspace === true) {
        inheritedNames.add(name);
        const inherited = isTable(workspaceDeps) ? workspaceDeps[name] : undefined;
        if (inherited === undefined) {
          throw new Error(
            `${path.join(crateDir, "Cargo.toml")}: dependency '${name}' sets workspace = true, but ` +
              `${path.join(root.dir, "Cargo.toml")} declares no [workspace.dependencies] '${name}'.`,
          );
        }
        if (isTable(inherited) && typeof inherited.path === "string") {
          out.push(path.resolve(root.dir, inherited.path));
        }
      }
    }
  }
  return out;
}

/** Package name → directory of every path crate the workspace root's `[patch]`
 *  tables substitute for a registry or git dependency. */
function patchedPathCrates(root: { dir: string; manifest: TomlTable }): Map<string, string> {
  const out = new Map<string, string>();
  const patch = root.manifest.patch;
  if (!isTable(patch)) return out;
  for (const registry of Object.values(patch)) {
    if (!isTable(registry)) continue;
    for (const [name, spec] of Object.entries(registry)) {
      if (!isTable(spec) || typeof spec.path !== "string") continue;
      const crate = typeof spec.package === "string" ? spec.package : name;
      out.set(crate, path.resolve(root.dir, spec.path));
    }
  }
  return out;
}

/** The git work tree `dir` belongs to. Not being able to ask is a failure. */
function gitTopLevel(dir: string): string {
  return realPath(git(dir, ["rev-parse", "--show-toplevel"]).trim());
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    throw new Error(
      `\`git ${args.join(" ")}\` failed in ${cwd}` +
        `${typeof stderr === "string" && stderr.trim() !== "" ? ` (${stderr.trim()})` : ""}. ` +
        `A crate's build inputs are the files git tracks, so the digest is taken in the ` +
        `repository's work tree.`,
    );
  }
}

/** A path with every link resolved, in the form the OS reports it. The native
 *  resolver, because it is the one that expands a Windows 8.3 short name
 *  (`RUNNER~1`) — git names the work tree by its long name, and a path compared
 *  against it in the other form reads as outside the repository. */
function realPath(target: string): string {
  return fs.realpathSync.native(target);
}

/** The files git tracks in `repo`, by repository-relative `/`-separated name.
 *  Listed once per digest and matched in memory: a process spawn costs far more
 *  than the listing, above all on Windows. */
class TrackedFiles {
  private readonly names: Set<string>;

  constructor(private readonly repo: string) {
    this.names = new Set(git(repo, ["ls-files", "-z", "--cached"]).split("\0").filter((name) => name !== ""));
  }

  private nameOf(file: string): string {
    return path.relative(this.repo, file).split(path.sep).join("/");
  }

  has(file: string): boolean {
    return this.names.has(this.nameOf(file));
  }

  /** The tracked files under `dirs`, absolute. A tracked file deleted from the
   *  work tree is not an input any more, so it is left out. */
  under(dirs: readonly string[]): string[] {
    const prefixes = dirs.map((dir) => this.nameOf(dir));
    return [...this.names]
      .filter((name) => prefixes.some((prefix) => prefix === "" || name.startsWith(`${prefix}/`)))
      .map((name) => path.join(this.repo, name))
      .filter((file) => fs.existsSync(file));
  }
}

/** JSON with object keys sorted, so equal TOML data renders to equal text. */
function canonical(value: TomlValue | undefined): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isTable(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface LockPackage {
  readonly name: string;
  readonly version: string;
  readonly source?: string;
  readonly entry: TomlTable;
}

/**
 * The `Cargo.lock` packages the given crates reach through the lock's own
 * dependency graph. A dependency is written `name`, `name version` or
 * `name version (source)` — as specific as the lock needs to tell packages of one
 * name apart — and one that matches no package, or several, is refused rather
 * than guessed.
 */
function reachedLockPackages(lockfile: string, crateNames: readonly string[]): LockPackage[] {
  const lock = parseCargoToml(fs.readFileSync(lockfile, "utf8"), lockfile);
  const packages: LockPackage[] = [];
  for (const entry of Array.isArray(lock.package) ? lock.package : []) {
    if (!isTable(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") {
      throw new Error(`${lockfile}: a [[package]] entry has no name or version.`);
    }
    packages.push({
      name: entry.name,
      version: entry.version,
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      entry,
    });
  }
  const find = (spec: string, from: string): LockPackage => {
    const match = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(spec);
    const candidates = match
      ? packages.filter(
          (p) =>
            p.name === match[1] &&
            (match[2] === undefined || p.version === match[2]) &&
            (match[3] === undefined || p.source === match[3]),
        )
      : [];
    if (candidates.length !== 1) {
      throw new Error(
        `${lockfile}: ${from} depends on '${spec}', which names ${candidates.length === 0 ? "no" : "more than one"} ` +
          `[[package]] — regenerate the lockfile with \`cargo generate-lockfile\`.`,
      );
    }
    return candidates[0]!;
  };

  const reached = new Set<LockPackage>();
  const queue = crateNames.map((name) => {
    const local = packages.filter((p) => p.name === name && p.source === undefined);
    if (local.length !== 1) {
      throw new Error(
        `${lockfile} has ${local.length === 0 ? "no" : "more than one"} entry for the path crate '${name}' — ` +
          `run \`cargo generate-lockfile\` in the workspace.`,
      );
    }
    return local[0]!;
  });
  while (queue.length > 0) {
    const pkg = queue.shift()!;
    if (reached.has(pkg)) continue;
    reached.add(pkg);
    const deps = pkg.entry.dependencies;
    for (const dep of Array.isArray(deps) ? deps : []) {
      if (typeof dep !== "string") throw new Error(`${lockfile}: '${pkg.name}' lists a non-string dependency.`);
      queue.push(find(dep, `'${pkg.name} ${pkg.version}'`));
    }
  }
  return [...reached];
}

/** The value at a dotted key path, or undefined. */
function valueAt(table: TomlTable, keys: readonly string[]): TomlValue | undefined {
  let current: TomlValue | undefined = table;
  for (const key of keys) current = isTable(current) ? current[key] : undefined;
  return current;
}

/**
 * The digest of a crate's build inputs, `sha256-<base64url>`: one line per input,
 * sorted — each tracked file of the crate and of every path crate it reaches
 * (workspace-root-relative path and content digest), each `Cargo.lock` package
 * those crates reach, each cargo configuration or toolchain file from the crate's
 * directory up to the repository root, and from the workspace root's
 * `Cargo.toml` the inherited `[workspace.dependencies]` entries plus `[patch]`,
 * `[replace]`, `[profile]` and `[workspace]`'s `resolver`, `package` and `lints`.
 */
export async function crateInputsDigest(crateDir: string): Promise<string> {
  const manifest = readManifest(crateDir);
  const root = workspaceRootOf(crateDir, manifest);
  const lockfile = path.join(root.dir, "Cargo.lock");
  if (!fs.existsSync(lockfile)) {
    throw new Error(
      `${root.dir} has no Cargo.lock. The lockfile fixes every registry dependency the build ` +
        `links, so it is part of the digest — generate it with \`cargo generate-lockfile\`.`,
    );
  }
  const repo = gitTopLevel(crateDir);
  const tracked = new TrackedFiles(repo);
  const rootDir = realPath(root.dir);
  const patched = patchedPathCrates(root);

  const crates = new Set<string>();
  const crateNames: string[] = [];
  const inheritedNames = new Set<string>();
  const walk = (start: string) => {
    const queue = [start];
    while (queue.length > 0) {
      const dir = realPath(queue.shift()!);
      if (crates.has(dir)) continue;
      if (!tracked.has(path.join(dir, "Cargo.toml"))) {
        throw new Error(
          `${path.join(dir, "Cargo.toml")} is not tracked by git. A build input is a committed ` +
            `file, so an uncommitted crate has none to digest — git add the crate.`,
        );
      }
      crates.add(dir);
      const own = dir === realPath(crateDir) ? manifest : readManifest(dir);
      const name = isTable(own.package) ? own.package.name : undefined;
      if (typeof name !== "string") throw new Error(`${path.join(dir, "Cargo.toml")} declares no [package] name.`);
      crateNames.push(name);
      queue.push(...pathDependencies(dir, own, root, inheritedNames));
    }
  };
  walk(crateDir);
  // A path crate the lock reaches that no path dependency named was substituted
  // by `[patch]`: its files link into the build as much as any other's.
  let reached = reachedLockPackages(lockfile, crateNames);
  for (;;) {
    const unwalked = reached.filter((p) => p.source === undefined && !crateNames.includes(p.name));
    if (unwalked.length === 0) break;
    for (const pkg of unwalked) {
      const dir = patched.get(pkg.name);
      if (dir === undefined) {
        throw new Error(
          `${lockfile}: the crate reaches the path package '${pkg.name}', but neither a path ` +
            `dependency nor a [patch] entry of ${path.join(root.dir, "Cargo.toml")} names its directory, ` +
            `so its files cannot be digested — regenerate the lockfile with \`cargo generate-lockfile\`.`,
        );
      }
      walk(dir);
    }
    reached = reachedLockPackages(lockfile, crateNames);
  }

  const lines = reached.map(
    (p) => `Cargo.lock#${p.name} ${p.version} ${p.source ?? ""}\0${canonical(p.entry)}`,
  );
  const workspace = isTable(root.manifest.workspace) ? root.manifest.workspace : {};
  const workspaceDeps = isTable(workspace.dependencies) ? workspace.dependencies : {};
  for (const name of inheritedNames) {
    lines.push(`Cargo.toml#workspace.dependencies.${name}\0${canonical(workspaceDeps[name])}`);
  }
  for (const keys of INHERITED_ROOT_KEYS) {
    const value = valueAt(root.manifest, keys);
    if (value !== undefined) lines.push(`Cargo.toml#${keys.join(".")}\0${canonical(value)}`);
  }

  const configs: string[] = [];
  for (let dir = realPath(crateDir); ; dir = path.dirname(dir)) {
    for (const name of BUILD_CONFIG_FILES) configs.push(path.join(dir, name));
    if (dir === repo || path.dirname(dir) === dir) break;
  }
  const inputs = new Set(tracked.under([...crates]));
  for (const config of configs) {
    if (tracked.has(config) && fs.existsSync(config)) inputs.add(config);
  }
  for (const file of inputs) {
    const name = path.relative(rootDir, file).split(path.sep).join("/");
    lines.push(`${name}\0${await sha256Base64Url(fs.readFileSync(file))}`);
  }
  lines.sort();
  return `sha256-${await sha256Base64Url(new TextEncoder().encode([...new Set(lines)].join("\n")))}`;
}

/** A crate-built source whose recorded inputs no longer describe its crate. */
export interface CrateInputsFailure {
  readonly module: string;
  readonly source: string;
  readonly message: string;
}

/** Recompute every crate-built source's inputs across `modules` and report each
 *  one that is unrecorded or has moved. */
export async function checkCrateInputs(
  modules: readonly DiscoveredModule[],
): Promise<CrateInputsFailure[]> {
  const failures: CrateInputsFailure[] = [];
  for (const module of modules) {
    const sources = moduleSources(module);
    if (sources instanceof Error) {
      failures.push({ module: module.key, source: "", message: sources.message });
      continue;
    }
    for (const source of sources) {
      if (source.build === undefined) continue;
      const { cargo, inputs } = source.build;
      const fail = (message: string) => failures.push({ module: module.key, source: source.name, message });
      let actual: string;
      try {
        actual = await crateInputsDigest(path.resolve(module.dir, cargo));
      } catch (err) {
        fail(`cannot digest crate '${cargo}': ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (inputs === undefined) {
        fail(
          `builds from crate '${cargo}' but records no build.inputs — run ` +
            `\`telo release stage --pin --module ${module.key}\` after rebuilding its files.`,
        );
      } else if (inputs !== actual) {
        fail(
          `the build inputs of crate '${cargo}' moved (recorded ${inputs}, now ${actual}): a ` +
            `tracked file of the crate or of a path crate it reaches, a lock package they reach, ` +
            `or a cargo configuration applying to the build changed since its files were built. ` +
            `Rebuild them and run \`telo release stage --pin --module ${module.key}\`.`,
        );
      }
    }
  }
  return failures;
}

function moduleSources(module: DiscoveredModule): ModuleSource[] | Error {
  const text = fs.readFileSync(module.manifestPath, "utf8");
  for (const doc of parseAllDocuments(text, { customTags: defaultCustomTags() })) {
    if (doc.errors.length > 0) {
      return new Error(
        `${module.manifestPath} does not parse, so its crate inputs cannot be checked: ` +
          doc.errors[0]!.message,
      );
    }
    const json = doc.toJSON() as { kind?: unknown } | null;
    if (typeof json?.kind !== "string" || !isModuleKind(json.kind)) continue;
    const { sources, problems } = readModuleSources(json);
    if (problems.length > 0) {
      return new Error(
        `its sources: block cannot be read, so its crate inputs cannot be checked:\n` +
          problems.map((problem) => `  ${problem.message}`).join("\n"),
      );
    }
    return sources;
  }
  return [];
}

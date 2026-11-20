/**
 * Measuring the telo floor of a module — by RUNNING published CLIs over it.
 *
 * `requires.telo` in a release workspace is not an opinion: it is the lowest
 * published telo that reads the module's syntax, `>=unreleased` when none does,
 * and absent when every telo that reads `requires:` accepts it. Support only
 * grows in newer releases, so the lowest accepting release is found by binary
 * search between {@link OLDEST_CLI_READING_REQUIRES} and the latest.
 *
 * **What is run is a copy.** The module is measured with the candidate floor in
 * place and every bound inside its `restrictions:` entries replaced by one the
 * measuring process meets, so `requires.telo` stays the static floor alone while
 * syntax inside an entry still counts (`requires-text.ts`). The copy sits beside
 * the manifest so relative imports and embedded files resolve as they do for the
 * module.
 *
 * **Acceptance is `telo check` of the published `@telorun/cli`**, attributed the
 * way the edge check always was: a non-zero run that says nothing about the
 * manifest under test (an argument shape an older parser rejects, an unreachable
 * remote import) proves nothing about it, and measuring on such a run would
 * write a wrong floor. It is an error instead.
 *
 * A module is rejected by what it IMPORTS too: an old CLI that cannot read a
 * pinned dependency reports the diagnostic at the dependency's file, as it cached
 * it, and no telo that cannot read the closure can host the module. Such a
 * diagnostic is a rejection and carries the dependency's location. Output
 * naming no file of the closure stays an error.
 */

import { isLocalPathSource, lowerBound, readRequires, upperBound } from "@telorun/analyzer";
import { resolveCacheRoot } from "@telorun/kernel";
import { defaultCustomTags } from "@telorun/templating";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";
import { promisify } from "node:util";
import { parseAllDocuments } from "yaml";
import { findModuleDoc, importSourceRefs } from "../commands/manifest-imports.js";
import { resolveSiblingManifest } from "../bundle/module-payload.js";
import { measurementCopy, stagedSourcePaths, withoutAuthoringInputs } from "./requires-text.js";

const run = promisify(execFile);

/**
 * The oldest published `@telorun/cli` that reads `requires:` — older ones reject
 * the key itself (`SCHEMA_VIOLATION`), so they say nothing about a module's
 * syntax. Found by execution: `telo check` of a library declaring
 * `requires: { telo: ">=999.0.0" }` reports `MODULE_REQUIRES_NEWER_RUNTIME` first
 * at 0.77.0 (0.76.0 and every version tried below it report `SCHEMA_VIOLATION`).
 */
export const OLDEST_CLI_READING_REQUIRES = "0.77.0";

/** The file the measurement copy is written to, beside the module's manifest. */
export const MEASUREMENT_FILE = ".telo-floor-measure.yaml";

/** Generous by design: a published CLI is fetched on first use. Bounds a hang. */
const RUN_TIMEOUT_MS = 600_000;

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type Floor =
  | { kind: "none" }
  | { kind: "unreleased" }
  | { kind: "version"; version: string };

export const NO_FLOOR: Floor = { kind: "none" };
export const UNRELEASED: Floor = { kind: "unreleased" };

export function floorText(floor: Floor): string {
  if (floor.kind === "none") return "(none)";
  if (floor.kind === "unreleased") return ">=unreleased";
  return `>=${floor.version}`;
}

export function sameFloor(a: Floor, b: Floor): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "version" || a.version === (b as typeof a).version;
}

/** A module manifest as measured. */
export interface MeasuredModule {
  /** The module's key, for reports. */
  key: string;
  manifestPath: string;
  text: string;
}

/** What a published CLI said about a module it rejected. */
export interface Reading {
  version: string;
  code?: string;
  /** `telo.yaml:25`, against the manifest rather than the measurement copy. */
  location?: string;
}

export function describeReading(reading: Reading): string {
  if (!reading.code) return `${reading.version} rejects it`;
  return `${reading.version} reports ${reading.code}${reading.location ? ` at ${reading.location}` : ""}`;
}

export interface Measurement {
  floor: Floor;
  /** Why the floor is not lower: the rejection of the release just below it, or
   *  of the latest release for `>=unreleased`. Absent for no floor. */
  reading?: Reading;
}

export class FloorMeasurementError extends Error {}

/** The registry could not tell which versions are published. */
export class RegistryUnreachableError extends FloorMeasurementError {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`cannot list published @telorun/cli versions from ${url} (${reason})`);
  }
}

/**
 * The published, non-prerelease `@telorun/cli` versions at or above
 * {@link OLDEST_CLI_READING_REQUIRES}, oldest first. Fails when the registry
 * cannot be reached: a floor measured against a guessed list is a wrong floor.
 */
export async function listPublishedFinals(
  fetchFn: typeof fetch = fetch,
  registry: string = process.env.npm_config_registry || DEFAULT_REGISTRY,
): Promise<string[]> {
  const url = `${registry.replace(/\/+$/, "")}/@telorun%2fcli`;
  let body: unknown;
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) throw new RegistryUnreachableError(url, `HTTP ${response.status}`);
    body = await response.json();
  } catch (err) {
    if (err instanceof RegistryUnreachableError) throw err;
    const cause = (err as { cause?: { code?: string } }).cause;
    throw new RegistryUnreachableError(
      url,
      cause?.code ?? (err instanceof Error ? err.message : String(err)),
    );
  }
  const versions = Object.keys((body as { versions?: Record<string, unknown> }).versions ?? {});
  return versions
    .filter((v) => semver.valid(v) !== null && semver.prerelease(v) === null)
    .filter((v) => semver.gte(v, OLDEST_CLI_READING_REQUIRES))
    .sort(semver.compare);
}

// ---------------------------------------------------------------------------
// Running the published CLI
// ---------------------------------------------------------------------------

export type CliRun =
  /** The CLI ran and accepted every manifest. */
  | { status: "passed" }
  /** It ran and exited non-zero. */
  | { status: "failed"; output: string }
  /** It never ran: the binary is missing, a fetch failed, the timeout fired. */
  | { status: "unavailable"; output: string };

/** `telo check <paths>` with `@telorun/cli@<version>`, `env` added to the
 *  environment it runs in. Injected in tests. */
export type CliRunner = (version: string, paths: string[], env?: Readonly<Record<string, string>>) => Promise<CliRun>;

/** Started away from the module's directory: `npx` reads the `.npmrc` of the
 *  directory it starts in, and one there naming another registry would decide
 *  which program is installed as `@telorun/cli`. */
export const npxRunner: CliRunner = async (version, paths, env) => {
  try {
    await run("npx", ["-y", `@telorun/cli@${version}`, "check", ...paths], {
      cwd: os.tmpdir(),
      env: env ? { ...process.env, ...env } : process.env,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: "passed" };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || (e.message ?? "check failed");
    return typeof e.code === "number"
      ? { status: "failed", output }
      : { status: "unavailable", output };
  }
};

/** Whether a run's output says anything about the file under test, compared on a
 *  trailing path fragment too since a CLI renders paths relative to its cwd. */
export function mentions(output: string, filePath: string): boolean {
  if (!output) return false;
  const tail = filePath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  if (output.includes(filePath)) return true;
  if (tail.length === 0) return false;
  for (let at = output.indexOf(tail); at !== -1; at = output.indexOf(tail, at + 1)) {
    if (at === 0 || /[\\/\s:]/.test(output[at - 1]!)) return true;
  }
  return false;
}

const NON_ERROR_DIAGNOSTIC = /:\d+(?::\d+)?\s+(?:warning|info)\s/;

/** Whether a failed run's output rejects the file: some line naming it is not a
 *  warning or info diagnostic, which a run fails on no more than it passes on. */
export function rejects(output: string, filePath: string): boolean {
  return output.split("\n").some((line) => mentions(line, filePath) && !NON_ERROR_DIAGNOSTIC.test(line));
}

const DIAGNOSTIC_AT = /^\s*(.+?):(\d+)(?::\d+)?\s+error\s+.*?([A-Z][A-Z0-9_]{2,})\s*$/;

/** The manifests a module reaches by relative imports, transitively, itself included. */
function relativeClosure(manifestPath: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const docs = parseAllDocuments(fs.readFileSync(abs, "utf8"), { customTags: defaultCustomTags });
    const moduleDoc = findModuleDoc(docs);
    if (!moduleDoc) return;
    for (const ref of importSourceRefs(moduleDoc)) {
      if (!isLocalPathSource(ref.source)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(abs), ref.source))) continue;
      visit(resolveSiblingManifest(path.dirname(abs), ref.source));
    }
  };
  visit(manifestPath);
  return seen;
}

/** Codes meaning a source could not be OBTAINED (a fetch, the network): a fact about
 *  the measuring environment, never about the module. `INVALID_IMPORT_SOURCE` is the
 *  author's and stays a rejection. */
const ENVIRONMENT_CODES = new Set(["IMPORT_UNRESOLVED"]);

function refuseEnvironmentFailure(version: string, code: string | undefined, line: string): void {
  if (code && ENVIRONMENT_CODES.has(code)) {
    throw new FloorMeasurementError(
      `telo ${version} could not obtain an import (${code}); that says nothing about the module, ` +
        `so it is treated as unmeasured rather than rejected. Output: ${line.trim().slice(0, 400)}`,
    );
  }
}

const CACHED_DEPENDENCY = /(?:^|\/)\.telo\/manifests\/(?:.*\/)?([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * The first diagnostic a failed run located in the module's import closure: a
 * relative import's file, or a pinned remote import as the measuring CLI cached
 * it (`.telo/manifests/**`), rendered as the dependency (`http-server@0.43.0
 * telo.yaml:137`) rather than as an absolute cache path.
 */
function readDependencyRejection(
  version: string,
  output: string,
  manifestPath: string,
  unmirror: (file: string) => string,
): Reading | undefined {
  const closure = relativeClosure(manifestPath);
  const cwd = os.tmpdir();
  for (const line of output.split("\n")) {
    const found = DIAGNOSTIC_AT.exec(line);
    if (!found) continue;
    const located = found[1]!.replace(/\\/g, "/");
    const [, , lineNo, code] = found;
    refuseEnvironmentFailure(version, code, line);
    const cached = CACHED_DEPENDENCY.exec(located);
    if (cached) {
      return { version, code, location: `${cached[1]}@${cached[2]} ${cached[3]}:${lineNo}` };
    }
    const file = unmirror(path.resolve(cwd, located));
    if (closure.has(file) && file !== path.resolve(manifestPath)) {
      return { version, code, location: `${path.relative(path.dirname(manifestPath), file)}:${lineNo}` };
    }
  }
  return undefined;
}

/**
 * Each relatively imported sibling of the modules whose published form differs
 * from its file (an authoring-input block to blank), by absolute path. A published
 * CLI reads a sibling's `telo.yaml` raw, while a consumer of the published
 * artifact never sees those blocks.
 */
function shadowedSiblings(modules: readonly MeasuredModule[]): {
  shadows: Map<string, string>;
  closure: Set<string>;
} {
  const shadows = new Map<string, string>();
  const closure = new Set<string>();
  for (const module of modules) {
    const entry = path.resolve(module.manifestPath);
    for (const file of relativeClosure(entry)) {
      if (file === entry) continue;
      closure.add(file);
      const text = fs.readFileSync(file, "utf8");
      const blanked = withoutAuthoringInputs(text);
      if (blanked !== text) shadows.set(file, blanked);
    }
  }
  return { shadows, closure };
}

/** Each file a blanked `sources:` block stages, by absolute path: published, the
 *  artifact holds them, so the measuring CLI must find them. */
function stagedPlaceholders(manifests: Iterable<{ file: string; text: string }>): Set<string> {
  const paths = new Set<string>();
  for (const { file, text } of manifests) {
    if (withoutAuthoringInputs(text) === text) continue;
    for (const staged of stagedSourcePaths(text)) paths.add(path.resolve(path.dirname(file), staged));
  }
  return paths;
}

interface Mirror {
  root: string;
  toMirror: (file: string) => string;
  toReal: (file: string) => string;
}

/** The cache directory, which a run in the mirror must not reach through a link:
 *  it is handed the real one by `TELO_CACHE_DIR` instead. */
const CACHE_DIRECTORY = ".telo";

/**
 * One real entry in the mirror, needing no privilege on any platform: a
 * directory as a junction (a symlink elsewhere), a file hard-linked or else
 * copied, a symlink recreated as one with its own target, dangling or not.
 * Where a file symlink needs a privilege the account lacks (Windows without
 * developer mode), a link to a file is laid as the file it resolves to and a
 * dangling one is left out: either way the mirror path reads as the real one.
 */
export function mirrorEntry(real: string, link: string, symlink: typeof fs.symlinkSync = fs.symlinkSync): void {
  const stat = fs.lstatSync(real);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(real);
    let resolved: fs.Stats | undefined;
    try {
      resolved = fs.statSync(real);
    } catch {
      // A dangling link is recreated as it is.
    }
    const directory = resolved?.isDirectory() === true;
    // A junction's target is resolved against the working directory, never the link's.
    const linked = directory && process.platform === "win32" ? path.resolve(path.dirname(real), target) : target;
    try {
      symlink(linked, link, directory ? "junction" : "file");
    } catch (error) {
      if (directory || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      if (resolved) linkFile(fs.realpathSync(real), link);
    }
  } else if (stat.isDirectory()) {
    symlink(real, link, "junction");
  } else {
    linkFile(real, link);
  }
}

/** A file in the mirror: hard-linked, or copied where it cannot be (another volume). */
function linkFile(real: string, link: string): void {
  try {
    fs.linkSync(real, link);
  } catch {
    fs.copyFileSync(real, link);
  }
}

/**
 * A scratch tree laying the directories of every shadowed file and every
 * measurement copy out as in the workspace, relative paths between them intact.
 * Each real entry is linked ({@link mirrorEntry}) except a cache directory; the
 * shadowed manifests and the measurement copies are files of their own. The
 * real tree is never written.
 */
function buildMirror(
  shadows: Map<string, string>,
  closure: Set<string>,
  copies: Map<string, string>,
  placeholders: ReadonlySet<string>,
): Mirror {
  const files = new Map<string, string>([...shadows, ...copies]);
  const dirs = new Set([...files.keys(), ...closure, ...placeholders].map((f) => path.dirname(f)));
  const ancestor = [...dirs]
    .map((d) => d.split(path.sep))
    .reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    })
    .join(path.sep) || path.sep;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-floor-mirror-"));
  const toMirror = (file: string): string => path.join(root, path.relative(ancestor, file));
  const laid = new Set<string>();

  const lay = (dir: string): void => {
    laid.add(dir);
    const target = toMirror(dir);
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const real = path.join(dir, entry);
      if (files.has(real) || entry === CACHE_DIRECTORY) continue;
      const holdsLaid = [...dirs].some((d) => d === real || d.startsWith(real + path.sep));
      if (holdsLaid && fs.statSync(real).isDirectory()) {
        lay(real);
      } else {
        mirrorEntry(real, path.join(target, entry));
      }
    }
    for (const [file, text] of files) {
      if (path.dirname(file) === dir) fs.writeFileSync(path.join(target, path.basename(file)), text);
    }
    for (const staged of placeholders) {
      if (path.dirname(staged) !== dir) continue;
      const at = path.join(target, path.basename(staged));
      try {
        fs.lstatSync(at);
      } catch {
        fs.writeFileSync(at, "");
      }
    }
  };
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
    if (!laid.has(dir)) lay(dir);
  }
  return {
    root,
    toMirror,
    toReal: (file) =>
      file === root || file.startsWith(root + path.sep)
        ? path.join(ancestor, path.relative(root, file))
        : file,
  };
}

export type ProbeVerdict = { accepted: true } | { accepted: false; reading: Reading };

interface Copy {
  module: MeasuredModule;
  path: string;
  /** Maps a file of the measurement mirror back to the real tree. */
  unmirror: (file: string) => string;
  atLine: number;
  delta: number;
}

/**
 * Runs published CLIs over measurement copies and says, per module, whether the
 * release accepted it or rejected it attributably.
 */
export class FloorProbe {
  constructor(private readonly runner: CliRunner) {}

  /**
   * `@telorun/cli@<version>` over the modules' copies with `floor` as the
   * candidate (`null`: no floor). Batched: one run when everything passes. A
   * failed batch is never itself a verdict — a module is rejected only on output
   * naming its own copy, and the rest are re-run, alone when nothing was named.
   */
  async probe(
    version: string,
    floor: string | null,
    modules: readonly MeasuredModule[],
  ): Promise<Map<string, ProbeVerdict>> {
    const { shadows, closure } = shadowedSiblings(modules);
    // A blanked `sources:` block means the mirror, which carries what it staged.
    const placeholders = stagedPlaceholders([
      ...modules.map((m) => ({ file: path.resolve(m.manifestPath), text: m.text })),
      ...[...closure].map((file) => ({ file, text: fs.readFileSync(file, "utf8") })),
    ]);
    const mirrored = shadows.size > 0 || modules.some((m) => withoutAuthoringInputs(m.text) !== m.text);
    // A run in the mirror is given the cache the real tree's run would resolve,
    // one batch per cache root.
    const cacheRoots = new Map<string, MeasuredModule[]>();
    if (mirrored) {
      for (const module of modules) {
        const root = resolveCacheRoot(path.resolve(module.manifestPath)) ?? "";
        cacheRoots.set(root, [...(cacheRoots.get(root) ?? []), module]);
      }
      if (cacheRoots.size > 1) {
        const verdicts = new Map<string, ProbeVerdict>();
        for (const group of cacheRoots.values()) {
          for (const [key, verdict] of await this.probe(version, floor, group)) verdicts.set(key, verdict);
        }
        return verdicts;
      }
    }
    const cacheRoot = [...cacheRoots.keys()][0];
    const env = cacheRoot ? { TELO_CACHE_DIR: cacheRoot } : undefined;
    const copies: Copy[] = [];
    let mirrorRoot: string | undefined;
    try {
      const texts = modules.map((m) => measurementCopy(m.text, floor));
      if (!mirrored) {
        modules.forEach((module, i) => {
          const file = path.join(path.dirname(module.manifestPath), MEASUREMENT_FILE);
          fs.writeFileSync(file, texts[i]!.text);
          copies.push({
            module,
            path: file,
            unmirror: (f) => f,
            atLine: texts[i]!.atLine,
            delta: texts[i]!.delta,
          });
        });
      } else {
        const measured = new Map(
          modules.map((m, i) => [
            path.join(path.dirname(path.resolve(m.manifestPath)), MEASUREMENT_FILE),
            texts[i]!.text,
          ]),
        );
        const mirror = buildMirror(shadows, closure, measured, placeholders);
        mirrorRoot = mirror.root;
        modules.forEach((module, i) => {
          copies.push({
            module,
            path: mirror.toMirror(
              path.join(path.dirname(path.resolve(module.manifestPath)), MEASUREMENT_FILE),
            ),
            unmirror: mirror.toReal,
            atLine: texts[i]!.atLine,
            delta: texts[i]!.delta,
          });
        });
      }
      const verdicts = new Map<string, ProbeVerdict>();
      await this.judge(version, copies, verdicts, env);
      return verdicts;
    } finally {
      for (const copy of copies) fs.rmSync(copy.path, { force: true });
      if (mirrorRoot) fs.rmSync(mirrorRoot, { recursive: true, force: true });
    }
  }

  private async judge(
    version: string,
    copies: Copy[],
    verdicts: Map<string, ProbeVerdict>,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<void> {
    const result = await this.runner(version, copies.map((c) => c.path), env);
    if (result.status === "passed") {
      for (const copy of copies) verdicts.set(copy.module.key, { accepted: true });
      return;
    }
    const named =
      result.status === "failed" ? copies.filter((c) => rejects(result.output, c.path)) : [];
    if (named.length === 0) {
      if (copies.length === 1 && result.status === "failed") {
        const reading = readDependencyRejection(
          version,
          result.output,
          copies[0]!.module.manifestPath,
          copies[0]!.unmirror,
        );
        if (reading) {
          verdicts.set(copies[0]!.module.key, { accepted: false, reading });
          return;
        }
      }
      if (copies.length === 1) {
        throw new FloorMeasurementError(
          `telo ${version} exited without reporting on ${copies[0]!.module.key}; ` +
            `treating the module as unmeasured rather than rejected. Output: ` +
            `${result.output.slice(0, 400) || "(none)"}`,
        );
      }
      for (const copy of copies) await this.judge(version, [copy], verdicts, env);
      return;
    }
    for (const copy of named) {
      verdicts.set(copy.module.key, {
        accepted: false,
        reading: readRejection(version, result.output, copy),
      });
    }
    const rest = copies.filter((c) => !named.includes(c));
    if (rest.length > 0) await this.judge(version, rest, verdicts, env);
  }
}

const DIAGNOSTIC = /:(\d+)(?::\d+)?\s+error\s+.*?([A-Z][A-Z0-9_]{2,})\s*$/;

function readRejection(version: string, output: string, copy: Copy): Reading {
  for (const line of output.split("\n")) {
    if (!mentions(line, copy.path)) continue;
    const found = DIAGNOSTIC.exec(line);
    if (!found) continue;
    refuseEnvironmentFailure(version, found[2], line);
    const reported = Number(found[1]);
    const line0 =
      copy.delta > 0
        ? reported > copy.atLine + copy.delta
          ? reported - copy.delta
          : copy.atLine + 1
        : reported > copy.atLine
          ? reported - copy.delta
          : reported;
    return {
      version,
      code: found[2],
      location: `${path.basename(copy.module.manifestPath)}:${line0}`,
    };
  }
  return { version };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface SearchState {
  module: MeasuredModule;
  lo: number;
  hi: number;
  rejections: Map<number, Reading>;
}

/**
 * The measured floor of each module, probed in lockstep so modules probing the
 * same release share one run. `finals` is {@link listPublishedFinals}.
 *
 * The oldest release that reads `requires:` accepting a module means no floor;
 * the latest rejecting it means `>=unreleased`; otherwise the lowest accepting
 * release in between.
 */
export async function measureFloors(
  modules: readonly MeasuredModule[],
  context: { probe: FloorProbe; finals: readonly string[] },
): Promise<Map<string, Measurement>> {
  const { probe, finals } = context;
  if (finals[0] !== OLDEST_CLI_READING_REQUIRES) {
    throw new FloorMeasurementError(
      `telo ${OLDEST_CLI_READING_REQUIRES}, the oldest release that reads requires:, is not ` +
        `among the published versions; nothing can be measured.`,
    );
  }
  const results = new Map<string, Measurement>();
  if (modules.length === 0) return results;

  const oldest = await probe.probe(OLDEST_CLI_READING_REQUIRES, null, modules);
  const rejections = new Map<string, Reading>();
  let pending: MeasuredModule[] = [];
  for (const module of modules) {
    const verdict = oldest.get(module.key)!;
    if (verdict.accepted) results.set(module.key, { floor: NO_FLOOR });
    else {
      rejections.set(module.key, verdict.reading);
      pending.push(module);
    }
  }

  const newest = finals.length - 1;
  if (pending.length > 0 && newest > 0) {
    const verdicts = await probe.probe(finals[newest]!, finals[newest]!, pending);
    const rejected: MeasuredModule[] = [];
    for (const module of pending) {
      const verdict = verdicts.get(module.key)!;
      if (verdict.accepted) continue;
      results.set(module.key, { floor: UNRELEASED, reading: verdict.reading });
      rejected.push(module);
    }
    pending = pending.filter((m) => !rejected.includes(m));
  } else {
    for (const module of pending) {
      results.set(module.key, { floor: UNRELEASED, reading: rejections.get(module.key) });
    }
    pending = [];
  }

  const states: SearchState[] = pending.map((module) => ({
    module,
    lo: 0,
    hi: newest,
    rejections: new Map([[0, rejections.get(module.key)!]]),
  }));
  for (;;) {
    const groups = new Map<number, SearchState[]>();
    for (const state of states) {
      if (state.hi - state.lo <= 1) continue;
      const mid = (state.lo + state.hi) >> 1;
      groups.set(mid, [...(groups.get(mid) ?? []), state]);
    }
    if (groups.size === 0) break;
    for (const [mid, group] of groups) {
      const verdicts = await probe.probe(
        finals[mid]!,
        finals[mid]!,
        group.map((s) => s.module),
      );
      for (const state of group) {
        const verdict = verdicts.get(state.module.key)!;
        if (verdict.accepted) state.hi = mid;
        else {
          state.lo = mid;
          state.rejections.set(mid, verdict.reading);
        }
      }
    }
  }
  for (const state of states) {
    results.set(state.module.key, {
      floor: { kind: "version", version: finals[state.hi]! },
      reading: state.rejections.get(state.lo),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Declared floors
// ---------------------------------------------------------------------------

export interface DeclaredFloor {
  floor: Floor;
  /** The upper bound a module's own `requires.telo` declares, which is refused. */
  ceiling?: string;
}

/** The floor a manifest declares at `requires.telo`. */
export function declaredFloor(text: string): DeclaredFloor {
  const owner = parseAllDocuments(text, { customTags: defaultCustomTags }).find((d) => {
    const kind = d.get("kind");
    return kind === "Telo.Application" || kind === "Telo.Library";
  });
  const doc = owner?.toJS() as Record<string, unknown> | undefined;
  const range = readRequires(doc).block.telo;
  if (!range) return { floor: NO_FLOOR };
  if (range.unreleased) return { floor: UNRELEASED };
  const low = lowerBound(range);
  const ceiling = upperBound(range)?.raw;
  const floor: Floor = low ? { kind: "version", version: low.raw } : NO_FLOOR;
  return ceiling ? { floor, ceiling } : { floor };
}

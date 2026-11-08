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
import { measurementCopy } from "./requires-text.js";

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

/** `telo check <paths>` with `@telorun/cli@<version>`. Injected in tests. */
export type CliRunner = (version: string, paths: string[]) => Promise<CliRun>;

/** Started away from the module's directory: `npx` reads the `.npmrc` of the
 *  directory it starts in, and one there naming another registry would decide
 *  which program is installed as `@telorun/cli`. */
export const npxRunner: CliRunner = async (version, paths) => {
  try {
    await run("npx", ["-y", `@telorun/cli@${version}`, "check", ...paths], {
      cwd: os.tmpdir(),
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
    const file = path.resolve(cwd, located);
    if (closure.has(file) && file !== path.resolve(manifestPath)) {
      return { version, code, location: `${path.relative(path.dirname(manifestPath), file)}:${lineNo}` };
    }
  }
  return undefined;
}

export type ProbeVerdict = { accepted: true } | { accepted: false; reading: Reading };

interface Copy {
  module: MeasuredModule;
  path: string;
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
    const copies: Copy[] = [];
    try {
      for (const module of modules) {
        const copy = measurementCopy(module.text, floor);
        const file = path.join(path.dirname(module.manifestPath), MEASUREMENT_FILE);
        fs.writeFileSync(file, copy.text);
        copies.push({ module, path: file, atLine: copy.atLine, delta: copy.delta });
      }
      const verdicts = new Map<string, ProbeVerdict>();
      await this.judge(version, copies, verdicts);
      return verdicts;
    } finally {
      for (const copy of copies) fs.rmSync(copy.path, { force: true });
    }
  }

  private async judge(
    version: string,
    copies: Copy[],
    verdicts: Map<string, ProbeVerdict>,
  ): Promise<void> {
    const result = await this.runner(version, copies.map((c) => c.path));
    if (result.status === "passed") {
      for (const copy of copies) verdicts.set(copy.module.key, { accepted: true });
      return;
    }
    const named =
      result.status === "failed" ? copies.filter((c) => mentions(result.output, c.path)) : [];
    if (named.length === 0) {
      if (copies.length === 1 && result.status === "failed") {
        const reading = readDependencyRejection(
          version,
          result.output,
          copies[0]!.module.manifestPath,
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
      for (const copy of copies) await this.judge(version, [copy], verdicts);
      return;
    }
    for (const copy of named) {
      verdicts.set(copy.module.key, {
        accepted: false,
        reading: readRejection(version, result.output, copy),
      });
    }
    const rest = copies.filter((c) => !named.includes(c));
    if (rest.length > 0) await this.judge(version, rest, verdicts);
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

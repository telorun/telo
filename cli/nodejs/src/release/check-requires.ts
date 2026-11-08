/**
 * Workspace-wide verification of declared `requires.telo` floors — the CI half of
 * measured floors (`floor-measurement.ts` is the measurement itself).
 *
 * A floor is correct when it is exactly what measurement would write, and that is
 * proven without writing anything and without a full search: a floor F holds when
 * the published CLI at F accepts the module and the release just below F rejects
 * it attributably; a missing floor holds when the oldest CLI that reads
 * `requires:` accepts the module; `>=unreleased` holds while the latest published
 * CLI still rejects it. Modules sharing a floor share the runs — two CLI runs per
 * distinct floor, however many modules declare it.
 *
 * A floor is also held to its relatively imported siblings' (`floor-propagation.ts`):
 * no published CLI gates a sibling's `requires:`, so the walk cannot see it. A floor
 * equal to the highest floor among the siblings it imports is correct though the
 * release just below accepts the module; a lower one is TOO_LOW, and every measured
 * value named in a failure is raised to the siblings' the same way.
 *
 * A registry that cannot be reached, or a run that says nothing about its manifest,
 * proves nothing: it is an error of the command, never a warning.
 *
 * Only when a floor FAILS is the module measured in full, to name the value
 * `telo release floor` would write.
 */

import * as fs from "node:fs";
import semver from "semver";
import {
  FloorProbe,
  FloorMeasurementError,
  OLDEST_CLI_READING_REQUIRES,
  RegistryUnreachableError,
  declaredFloor,
  describeReading,
  floorText,
  listPublishedFinals,
  measureFloors,
  npxRunner,
  type CliRunner,
  type Floor,
  type Measurement,
  type MeasuredModule,
  type Reading,
} from "./floor-measurement.js";
import {
  compareFloors,
  propagate,
  siblingClause,
  siblingFloor,
  workspaceImports,
  type PropagatedMeasurement,
  type SiblingFloor,
} from "./floor-propagation.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

export type FloorFailureCode = "REQUIRES_FLOOR_TOO_LOW" | "REQUIRES_FLOOR_TOO_HIGH";

export interface FloorFailure {
  module: string;
  code: FloorFailureCode;
  message: string;
  /** What `telo release floor` would write, when it could be measured. */
  measured?: string;
}

export interface FloorCheck {
  /** The declared floor the modules share, as written (`(none)` for no floor). */
  floor: string;
  modules: string[];
  /** `unavailable`: nothing could be proven, which fails the command. */
  status: "passed" | "unavailable";
  detail?: string;
}

export interface CheckRequiresResult {
  checks: FloorCheck[];
  failures: FloorFailure[];
  /** Why nothing could be proven: the registry, or a run about no manifest. Each fails the command. */
  errors: string[];
  /** True when a floor was proven wrong. */
  refuted: boolean;
}

export interface CheckRequiresOptions {
  /** The line version in this tree: a floor naming it is the one the version step
   *  just wrote, and may name a release npm does not have yet. */
  currentVersion: string;
  runner?: CliRunner;
  /** Published finals; fetched from the registry when omitted. */
  finals?: readonly string[];
}

type Verdict =
  | { pass: true }
  | {
      pass: false;
      code: FloorFailureCode;
      /** The reading of the release the module failed on, or of the lower release
       *  that accepted it. */
      reading?: Reading;
      unpublished?: { latest: string };
      lowerAccepts?: string;
      /** The sibling whose floor the declared one is below. */
      sibling?: { key: string; floor: Floor };
    };

export async function checkWorkspaceRequires(
  workspace: Workspace,
  options: CheckRequiresOptions,
): Promise<CheckRequiresResult> {
  const modules = workspace.modules.map(measuredFrom).filter((m): m is Declared => m !== undefined);
  let finals: readonly string[];
  try {
    finals = options.finals ?? (await listPublishedFinals());
  } catch (err) {
    if (!(err instanceof RegistryUnreachableError)) throw err;
    return unavailable(modules, err.message);
  }
  const imports = workspaceImports(workspace);
  const declared = new Map(modules.map((m) => [m.key, m.floor]));
  const siblings = new Map(modules.map((m) => [m.key, siblingFloor(m.key, imports, declared)]));
  const probe = new FloorProbe(options.runner ?? npxRunner);

  const groups = new Map<string, Declared[]>();
  for (const module of modules) {
    const key = floorText(module.floor);
    groups.set(key, [...(groups.get(key) ?? []), module]);
  }

  const checks: FloorCheck[] = [];
  const errors: string[] = [];
  const failed = new Map<Declared, Extract<Verdict, { pass: false }>>();
  for (const [text, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let verdicts: Map<string, Verdict>;
    try {
      verdicts = await verifyGroup(group[0]!.floor, group, finals, probe, options.currentVersion, siblings);
    } catch (err) {
      if (!(err instanceof FloorMeasurementError)) throw err;
      checks.push({ floor: text, modules: group.map((m) => m.key), status: "unavailable", detail: err.message });
      errors.push(`telo ${text}: ${err.message}`);
      continue;
    }
    const passed: string[] = [];
    for (const module of group) {
      const verdict = verdicts.get(module.key)!;
      if (verdict.pass) passed.push(module.key);
      else failed.set(module, verdict);
    }
    if (passed.length > 0) checks.push({ floor: text, modules: passed, status: "passed" });
  }

  const failures = await explain(failed, finals, probe, siblings);
  return { checks, failures, errors, refuted: failures.length > 0 };
}

interface Declared extends MeasuredModule {
  floor: Floor;
}

function measuredFrom(module: DiscoveredModule): Declared | undefined {
  let text: string;
  try {
    text = fs.readFileSync(module.manifestPath, "utf8");
  } catch {
    return undefined;
  }
  return {
    key: module.key,
    manifestPath: module.manifestPath,
    text,
    floor: declaredFloor(text).floor,
  };
}

function unavailable(modules: Declared[], detail: string): CheckRequiresResult {
  return {
    checks: [{ floor: "(all)", modules: modules.map((m) => m.key), status: "unavailable", detail }],
    failures: [],
    errors: [detail],
    refuted: false,
  };
}

async function verifyGroup(
  floor: Floor,
  group: Declared[],
  finals: readonly string[],
  probe: FloorProbe,
  currentVersion: string,
  siblings: ReadonlyMap<string, SiblingFloor>,
): Promise<Map<string, Verdict>> {
  const verdicts = new Map<string, Verdict>();
  const pass: Verdict = { pass: true };
  const latest = finals[finals.length - 1]!;

  // A floor below the siblings' fails whatever a release accepts; one equal to a
  // sibling's is decided by it, so only its own acceptance remains to prove.
  const pinned = new Set<string>();
  const unpinned: Declared[] = [];
  for (const module of group) {
    const sibling = siblings.get(module.key)!;
    const against = compareFloors(floor, sibling.floor);
    if (against < 0) {
      verdicts.set(module.key, {
        pass: false,
        code: "REQUIRES_FLOOR_TOO_LOW",
        sibling: { key: sibling.key!, floor: sibling.floor },
      });
      continue;
    }
    if (against === 0 && floor.kind !== "none") pinned.add(module.key);
    unpinned.push(module);
  }
  if (floor.kind === "unreleased") {
    for (const module of unpinned) if (pinned.has(module.key)) verdicts.set(module.key, pass);
  }
  group = unpinned.filter((m) => !verdicts.has(m.key));
  if (group.length === 0) return verdicts;

  if (floor.kind === "none") {
    const run = await probe.probe(OLDEST_CLI_READING_REQUIRES, null, group);
    for (const module of group) {
      const verdict = run.get(module.key)!;
      verdicts.set(
        module.key,
        verdict.accepted ? pass : { pass: false, code: "REQUIRES_FLOOR_TOO_LOW", reading: verdict.reading },
      );
    }
    return verdicts;
  }

  if (floor.kind === "unreleased") {
    const run = await probe.probe(latest, latest, group);
    for (const module of group) {
      const verdict = run.get(module.key)!;
      verdicts.set(
        module.key,
        verdict.accepted
          ? { pass: false, code: "REQUIRES_FLOOR_TOO_HIGH", lowerAccepts: latest }
          : pass,
      );
    }
    return verdicts;
  }

  const target = floor.version;
  const tooHigh = (extra: Partial<Extract<Verdict, { pass: false }>> = {}): Verdict => ({
    pass: false,
    code: "REQUIRES_FLOOR_TOO_HIGH",
    ...extra,
  });
  if (semver.lte(target, OLDEST_CLI_READING_REQUIRES)) {
    for (const module of group) verdicts.set(module.key, tooHigh());
    return verdicts;
  }
  const published = finals.includes(target);
  if (!published && target !== currentVersion) {
    for (const module of group) verdicts.set(module.key, tooHigh({ unpublished: { latest } }));
    return verdicts;
  }

  let remaining = group;
  if (published) {
    const run = await probe.probe(target, target, remaining);
    for (const module of group) {
      const verdict = run.get(module.key)!;
      if (!verdict.accepted) {
        verdicts.set(module.key, { pass: false, code: "REQUIRES_FLOOR_TOO_LOW", reading: verdict.reading });
      }
    }
    remaining = remaining.filter((m) => !verdicts.has(m.key));
  }
  for (const module of remaining) if (pinned.has(module.key)) verdicts.set(module.key, pass);
  remaining = remaining.filter((m) => !verdicts.has(m.key));
  const below = [...finals].reverse().find((v) => semver.lt(v, target));
  if (below !== undefined && remaining.length > 0) {
    const run = await probe.probe(below, below, remaining);
    for (const module of remaining) {
      verdicts.set(module.key, run.get(module.key)!.accepted ? tooHigh({ lowerAccepts: below }) : pass);
    }
  }
  for (const module of group) if (!verdicts.has(module.key)) verdicts.set(module.key, pass);
  return verdicts;
}

/** The failures, each naming what `telo release floor` would write. */
async function explain(
  failed: Map<Declared, Extract<Verdict, { pass: false }>>,
  finals: readonly string[],
  probe: FloorProbe,
  siblings: ReadonlyMap<string, SiblingFloor>,
): Promise<FloorFailure[]> {
  if (failed.size === 0) return [];
  let unmeasured: string | undefined;
  let measurements = new Map<string, Measurement>();
  try {
    measurements = await measureFloors([...failed.keys()], { probe, finals });
  } catch (err) {
    if (!(err instanceof FloorMeasurementError)) throw err;
    unmeasured = err.message;
  }
  const failures: FloorFailure[] = [];
  for (const [module, verdict] of failed) {
    const own = measurements.get(module.key);
    const measured = own ? propagate(own, siblings.get(module.key)!) : undefined;
    failures.push({
      module: module.key,
      code: verdict.code,
      message: messageFor(module, verdict, measured, unmeasured),
      ...(measured ? { measured: floorText(measured.floor) } : {}),
    });
  }
  return failures;
}

function measuredClause(measured: PropagatedMeasurement | undefined, unmeasured?: string): string {
  if (!measured) {
    return `the measured floor could not be determined${unmeasured ? ` (${unmeasured})` : ""}`;
  }
  const by = measured.sibling ? ` (${siblingClause(measured.sibling)})` : "";
  if (measured.floor.kind === "version") {
    return `the lowest published telo that accepts this module is ${measured.floor.version}${by}`;
  }
  if (measured.floor.kind === "unreleased") return `no published telo accepts this module${by}`;
  return `telo ${OLDEST_CLI_READING_REQUIRES}, the oldest telo that reads requires:, accepts it, so it needs no floor`;
}

function messageFor(
  module: Declared,
  verdict: Extract<Verdict, { pass: false }>,
  measured: PropagatedMeasurement | undefined,
  unmeasured?: string,
): string {
  const fix = ` Run \`telo release floor --module ${module.key}\`.`;
  const declared =
    module.floor.kind === "none" ? "requires.telo is missing" : `requires.telo is '${floorText(module.floor)}'`;

  if (verdict.code === "REQUIRES_FLOOR_TOO_LOW" && verdict.sibling) {
    return `${declared}; ${siblingClause(verdict.sibling)}, and ${measuredClause(measured, unmeasured)}.${fix}`;
  }
  if (verdict.code === "REQUIRES_FLOOR_TOO_LOW") {
    const reading = verdict.reading ? `telo ${describeReading(verdict.reading)}` : "the floor is too low";
    return `${declared}; ${reading}, and ${measuredClause(measured, unmeasured)}.${fix}`;
  }
  if (verdict.unpublished) {
    return (
      `${declared}; no published telo is ${module.floor.kind === "version" ? module.floor.version : ""} ` +
      `(the latest is ${verdict.unpublished.latest}); ${measuredClause(measured, unmeasured)}.${fix}`
    );
  }
  if (module.floor.kind === "unreleased" && verdict.lowerAccepts) {
    const accepting =
      measured?.floor.kind === "version" ? measured.floor.version : verdict.lowerAccepts;
    const sentence =
      measured?.floor.kind === "none"
        ? `${measuredClause(measured, unmeasured)}`
        : `published telo ${accepting} accepts this module`;
    return `${declared}; ${sentence}.${fix}`;
  }
  const accepts = verdict.lowerAccepts ? `telo ${verdict.lowerAccepts} accepts this module` : "";
  const lead = accepts || `${floorText(module.floor)} is at or below the oldest telo that reads requires:`;
  return `${declared}; ${lead}, and ${measuredClause(measured, unmeasured)}.${fix}`;
}

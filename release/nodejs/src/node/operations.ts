/**
 * The release commands' work, over any host's adapters: plan, apply, verify,
 * order and tag. The yargs wiring is `commands.ts`; what touches the tree is here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isCandidateId, isReleaseVersion, compareVersions, parseCandidateVersion } from "../bump-level.js";
import { prependChangelogRelease, renderChangelogRelease, CHANGELOG_FILE } from "../changelog.js";
import type { UnitKey } from "../fragment.js";
import {
  EMPTY_LAYERS,
  LEDGER_PATH,
  parseLedger,
  type AnchorDigest,
  type Ledger,
  type LedgerEntry,
  type UnitLayers,
} from "../ledger.js";
import {
  orderByImports,
  planRelease,
  recordRelease,
  type RecordedReading,
  type ReleaseDiagnostic,
  type ReleasePlan,
  type UnitEvidence,
} from "../release-plan.js";
import { readUnitVersions, stampUnitVersion, type ResolvedUnit } from "../units.js";
import { carriedBy } from "./carried-changes.js";
import {
  collectEvidence,
  destinationDiagnostics,
  openSessions,
  publishes,
  sessionOf,
  unitEvidence,
  type AnchorRef,
  type Sessions,
} from "./evidence.js";
import { createTag, fileAt, headCommit, tagCommit } from "./git.js";
import type { ReleaseHost } from "./host.js";
import { deleteFragment, readFragments, readLedger, writeLedger } from "./ledger-store.js";
import { loadReleaseWorkspace, readWorkspaceFile, type ReleaseWorkspace } from "./workspace.js";

export type Argv = Readonly<Record<string, unknown>>;

export function loadWorkspaceFor(host: ReleaseHost, from: string = process.cwd()): ReleaseWorkspace {
  return loadReleaseWorkspace(from, {
    adapters: host.adapters,
    ...(host.ecosystemHosts ? { ecosystemHosts: host.ecosystemHosts } : {}),
    ...(host.readMarker ? { readMarker: host.readMarker } : {}),
    command: host.command,
  });
}

/** The pending fragments, less those `ref` carries. */
export function pendingFragments(root: string, ref: string | undefined) {
  const fragments = readFragments(root);
  if (!ref) return fragments;
  const carried = carriedBy({ cwd: root, files: fragments.map((fragment) => fragment.source), ref });
  return fragments.filter((fragment) => !carried.has(fragment.source));
}

export interface PlanRun {
  readonly workspace: ReleaseWorkspace;
  readonly ledger: Ledger;
  readonly sessions: Sessions;
  readonly evidence: readonly UnitEvidence[];
  readonly plan: ReleasePlan;
}

export interface PlanOptions {
  readonly baseRef: string;
  readonly carriedBy?: string;
  readonly candidate?: string;
  readonly onUnit?: (unit: ResolvedUnit, index: number, total: number) => void;
}

/**
 * The plan of one workspace. What is decidable before any layer is built — the
 * marker, each ecosystem's own refusals, destinations — is checked first and
 * short-circuits, so a wrong marker is not reported after minutes of builds.
 */
export async function planWorkspaceRelease(
  host: ReleaseHost,
  workspace: ReleaseWorkspace,
  argv: Argv,
  options: PlanOptions,
): Promise<PlanRun> {
  const ledger = readLedger(workspace.root, host.ledger ?? {});
  const fragments = pendingFragments(workspace.root, options.carriedBy);
  const sessions = await openSessions(workspace, host.evidence, { ledger, argv });
  const upfront = upfrontDiagnostics(host, workspace, sessions);
  if (upfront.some((diagnostic) => diagnostic.severity === "error")) {
    return { workspace, ledger, sessions, evidence: [], plan: { units: [], fragments: [], diagnostics: upfront } };
  }
  const evidence = await collectEvidence(workspace, sessions, {
    baseRef: options.baseRef,
    ...(options.onUnit ? { onUnit: options.onUnit } : {}),
  });
  const plan = planRelease(
    { units: evidence, ledger, fragments, groups: workspace.release.groups },
    options.candidate ? { candidate: options.candidate } : {},
  );
  return { workspace, ledger, sessions, evidence, plan: { ...plan, diagnostics: [...upfront, ...plan.diagnostics] } };
}

export function upfrontDiagnostics(
  host: ReleaseHost,
  workspace: ReleaseWorkspace,
  sessions: Sessions,
): ReleaseDiagnostic[] {
  return [
    ...workspace.diagnostics,
    ...[...sessions.values()].flatMap((session) => session.diagnostics ?? []),
    ...destinationDiagnostics(workspace, host.evidence, sessions),
  ];
}

export function candidateId(value: unknown): string | undefined {
  if (value === undefined || value === false) return undefined;
  const id = value === true || value === "" ? "rc" : String(value);
  if (!isCandidateId(id)) {
    throw new Error(`'${id}' is not a candidate identifier: lowercase letters and digits, starting with a letter (rc, beta).`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface Applied {
  readonly key: UnitKey;
  readonly from: string;
  readonly to: string;
  /** Workspace-relative paths written for this unit. */
  readonly files: readonly string[];
}

/**
 * The bytes every file an apply may write held before it began, so an apply
 * that fails — a stamp, a host hook, or the reading the ledger is recorded
 * from — leaves the tree as it found it rather than half-versioned.
 */
class ApplyJournal {
  private readonly originals = new Map<string, string | undefined>();
  constructor(private readonly root: string) {}

  remember(file: string): void {
    if (this.originals.has(file)) return;
    const absolute = path.join(this.root, file);
    this.originals.set(file, fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined);
  }

  has(file: string): boolean {
    return this.originals.has(file);
  }

  /** Every file put back as it was; the ones that could not be, with why. */
  restore(): string[] {
    const failed: string[] = [];
    for (const [file, text] of this.originals) {
      const absolute = path.join(this.root, file);
      try {
        if (text === undefined) fs.rmSync(absolute, { force: true });
        else fs.writeFileSync(absolute, text, "utf8");
      } catch (error) {
        failed.push(`${file} (${(error as Error).message})`);
      }
    }
    return failed;
  }
}

/**
 * Write the plan: every version location of each moved unit and the files that
 * move with them, its changelog (a final only), what the host adds, then the
 * ledger — recorded from a second reading taken after the versions are on disk,
 * because that is what ships — and the consumed fragments deleted. Any failure
 * restores every file written, so the ledger is never recorded from a failed
 * reading and no version is left stamped without it.
 */
export async function applyPlan(
  host: ReleaseHost,
  run: PlanRun,
  argv: Argv,
  date: string,
): Promise<{ applied: Applied[]; written: string[] }> {
  const { workspace, plan } = run;
  const journal = new ApplyJournal(workspace.root);
  // A hook writes the files it names itself, after the fact: every version
  // location in the workspace is what a hook moves, so all are kept up front.
  for (const unit of workspace.units) for (const location of unit.versionLocations) journal.remember(location.file);
  journal.remember(LEDGER_PATH);
  for (const fragment of plan.fragments) journal.remember(fragment);
  const unjournaled = (files: readonly string[]) => files.filter((file) => !journal.has(file));
  const hookWrites: string[] = [];
  try {
    const read = (relative: string) => readWorkspaceFile(workspace, relative);
    const applied: Applied[] = [];
    for (const planned of plan.units) {
      const unit = workspace.units.find((candidate) => candidate.key === planned.key)!;
      const files: string[] = [];
      const write = (file: string, text: string) => {
        journal.remember(file);
        fs.writeFileSync(path.join(workspace.root, file), text, "utf8");
        if (!files.includes(file)) files.push(file);
      };
      for (const { file, text } of stampUnitVersion(unit, planned.to, read, workspace.adapters)) write(file, text);
      for (const location of unit.versionLocations) {
        const handler = workspace.adapters.handlerFor(path.posix.basename(location.file));
        for (const companion of handler?.companions?.(location.file, planned.to, read) ?? []) {
          write(companion.file, companion.text);
        }
      }
      for (const anchor of unit.anchors) {
        const session = sessionOf(run.sessions, anchor.ecosystem);
        for (const file of (await session.afterStamp?.({ unit, anchor }, planned.to, plan)) ?? []) {
          hookWrites.push(file);
          if (!files.includes(file)) files.push(file);
        }
      }
      if (!plan.candidate && planned.entries.length > 0) {
        const changelog = unit.dir === "" ? CHANGELOG_FILE : `${unit.dir}/${CHANGELOG_FILE}`;
        write(
          changelog,
          prependChangelogRelease(read(changelog), renderChangelogRelease({ version: planned.to, date, entries: planned.entries })),
        );
      }
      applied.push({ key: planned.key, from: planned.from, to: planned.to, files });
    }
    const extra = (await host.afterApply?.(workspace, plan, argv)) ?? [];
    hookWrites.push(...extra);

    const after = loadWorkspaceFor(host, workspace.root);
    const recorded = await recordedLedger(host, after, run.ledger, plan, argv);
    writeLedger(workspace.root, recorded);
    for (const fragment of plan.fragments) deleteFragment(workspace.root, fragment);
    const written = [...new Set([...applied.flatMap((unit) => unit.files), ...extra, LEDGER_PATH, ...plan.fragments])];
    return { applied, written };
  } catch (error) {
    const left = [...unjournaled(hookWrites), ...journal.restore()];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nThe apply was undone: every version, changelog and ledger file it wrote is restored` +
        (left.length > 0 ? `, except ${left.join(", ")}, which could not be restored and must be checked by hand.` : "."),
      { cause: error },
    );
  }
}

/** The ledger once this plan is published, read from the tree as it now is. */
export async function recordedLedger(
  host: ReleaseHost,
  workspace: ReleaseWorkspace,
  ledger: Ledger,
  plan: ReleasePlan,
  argv: Argv,
): Promise<Ledger> {
  const sessions = await openSessions(workspace, host.evidence, { ledger, argv });
  const readings = new Map<UnitKey, RecordedReading>();
  const planned = new Set(plan.units.map((unit) => unit.key));
  for (const unit of workspace.units) {
    if (!planned.has(unit.key)) continue;
    const evidence = await unitEvidence(workspace, sessions, unit, false);
    readings.set(unit.key, { layers: evidence.layers, ...(evidence.registry ? { registry: evidence.registry } : {}) });
  }
  return recordRelease(ledger, plan, readings);
}

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

export interface OrderRow {
  readonly key: UnitKey;
  readonly ecosystem?: string;
  /** The workspace-relative directory to publish from. */
  readonly path: string;
  readonly version: string;
  readonly destination?: string;
  readonly group?: string;
  /** The units this one's payload names, which publish first. */
  readonly imports: readonly UnitKey[];
}

/**
 * One row per unit and publishing anchor, units in edge order (a dependency
 * before its dependents), one unit's rows together and sorted by ecosystem. A
 * unit with no ecosystem gives one row with none; an anchor publishing nothing
 * (a private package) gives none. Reads edges only — no layer is built.
 */
export async function orderRows(host: ReleaseHost, workspace: ReleaseWorkspace, argv: Argv): Promise<{
  rows: OrderRow[];
  diagnostics: ReleaseDiagnostic[];
}> {
  const ledger = readLedger(workspace.root, host.ledger ?? {});
  const sessions = await openSessions(workspace, host.evidence, { ledger, argv });
  const diagnostics = upfrontDiagnostics(host, workspace, sessions);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { rows: [], diagnostics };
  const units: { key: UnitKey; unit: ResolvedUnit; imports: UnitKey[] }[] = [];
  for (const unit of workspace.units) {
    const imports = new Set<UnitKey>();
    for (const anchor of unit.anchors) {
      for (const key of await sessionOf(sessions, anchor.ecosystem).imports({ unit, anchor })) {
        if (key !== unit.key) imports.add(key);
      }
    }
    units.push({ key: unit.key, unit, imports: [...imports].sort() });
  }
  const rows: OrderRow[] = [];
  for (const { unit, imports } of orderByImports(units)) {
    const version = readUnitVersions(unit, (relative) => workspace.tree.readFile(relative), workspace.adapters)[0]?.value ?? "";
    const common = { key: unit.key, version, ...(unit.group ? { group: unit.group } : {}), imports };
    if (unit.anchors.length === 0) {
      rows.push({ ...common, path: unit.dir || "." });
      continue;
    }
    const anchors = [...unit.anchors].sort((a, b) =>
      a.ecosystem === b.ecosystem ? a.anchor.localeCompare(b.anchor) : a.ecosystem.localeCompare(b.ecosystem),
    );
    for (const anchor of anchors) {
      if (!publishes(anchor)) continue;
      const destination = sessionOf(sessions, anchor.ecosystem).destination?.({ unit, anchor });
      rows.push({
        ...common,
        ecosystem: anchor.ecosystem,
        path: anchor.dir || ".",
        ...(destination !== undefined ? { destination } : {}),
      });
    }
  }
  return { rows, diagnostics };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface VerifyFinding {
  readonly key: UnitKey;
  readonly layer: string;
  readonly kind: "drift" | "unverifiable";
  readonly detail: string;
}

/**
 * Reconcile the ledger against the registries, per layer. The ledger is a cache
 * of what each registry serves, so the question is only whether it is stale; no
 * local layer is built. A layer with no read-back keeps its recorded digest and
 * is reported unverifiable. A unit carrying a candidate version is reconciled as
 * a candidate record beside the newest final published below it.
 */
export async function verifyLedger(
  host: ReleaseHost,
  workspace: ReleaseWorkspace,
  argv: Argv,
  progress: (text: string) => void,
): Promise<{ findings: VerifyFinding[]; ledger: Ledger; diagnostics: ReleaseDiagnostic[] }> {
  const ledger = readLedger(workspace.root, host.ledger ?? {});
  const sessions = await openSessions(workspace, host.evidence, { ledger, argv });
  const diagnostics = upfrontDiagnostics(host, workspace, sessions);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { findings: [], ledger, diagnostics };

  const findings: VerifyFinding[] = [];
  const units = new Map<UnitKey, LedgerEntry>(ledger.units);
  for (const [index, unit] of workspace.units.entries()) {
    progress(`  [${index + 1}/${workspace.units.length}] ${unit.key}`);
    const version = readUnitVersions(unit, (relative) => workspace.tree.readFile(relative), workspace.adapters)[0]?.value;
    if (!version) continue;
    const recorded = ledger.units.get(unit.key);
    const candidate = parseCandidateVersion(version);
    const registry = registryOf(unit, sessions);
    if (candidate) {
      const finalVersion = recorded?.version ?? (await newestFinalBelow(unit, sessions, candidate.final));
      const final = finalVersion
        ? await reconcile(unit, sessions, finalVersion, recorded?.layers, findings)
        : undefined;
      const record = await reconcile(unit, sessions, version, recorded?.candidate?.layers, findings);
      units.set(unit.key, {
        ...(final?.published && finalVersion ? { version: finalVersion } : {}),
        ...(registry ? { registry } : {}),
        layers: final?.published ? final.layers : EMPTY_LAYERS,
        ...(record.published ? { candidate: { version, layers: record.layers } } : {}),
      });
      if (!final?.published && !record.published) units.delete(unit.key);
      continue;
    }
    if (!isReleaseVersion(version)) continue;
    const final = await reconcile(unit, sessions, version, recorded?.version === version ? recorded.layers : undefined, findings);
    if (!final.published) {
      if (recorded?.version !== undefined) {
        findings.push({ key: unit.key, layer: "*", kind: "drift", detail: `the ledger records ${recorded.version}, which is not published` });
        units.delete(unit.key);
      }
      continue;
    }
    if (!recorded) findings.push({ key: unit.key, layer: "*", kind: "drift", detail: `published at ${version}, but the ledger has no entry` });
    units.set(unit.key, { version, ...(registry ? { registry } : {}), layers: final.layers });
  }
  return { findings, ledger: { units }, diagnostics };
}

function registryOf(unit: ResolvedUnit, sessions: Sessions): string | undefined {
  for (const anchor of unit.anchors) {
    const found = sessions.get(anchor.ecosystem)?.registry?.({ unit, anchor });
    if (found) return found;
  }
  return undefined;
}

async function newestFinalBelow(unit: ResolvedUnit, sessions: Sessions, final: string): Promise<string | undefined> {
  for (const anchor of unit.anchors) {
    const session = sessions.get(anchor.ecosystem);
    if (!session?.publishedVersions || !publishes(anchor)) continue;
    const versions = (await session.publishedVersions({ unit, anchor }))
      .filter((v) => isReleaseVersion(v) && compareVersions(v, final) < 0)
      .sort(compareVersions);
    return versions.pop();
  }
  return undefined;
}

/** Every layer of `unit` at `version`, read back where it can be. `published`
 *  when at least one layer was found at the registry. */
async function reconcile(
  unit: ResolvedUnit,
  sessions: Sessions,
  version: string,
  recorded: UnitLayers | undefined,
  findings: VerifyFinding[],
): Promise<{ published: boolean; layers: UnitLayers }> {
  const ecosystems: Record<string, Record<string, AnchorDigest>> = {};
  let published = false;
  let verifiable = false;
  let kept = false;
  for (const anchor of unit.anchors) {
    if (!publishes(anchor)) continue;
    const ref: AnchorRef = { unit, anchor };
    const was = recorded?.ecosystems[anchor.ecosystem]?.[anchor.anchor];
    const keep = () => {
      if (was === undefined) return;
      (ecosystems[anchor.ecosystem] ??= {})[anchor.anchor] = was;
      kept = true;
    };
    const layer = `${anchor.ecosystem}/${anchor.anchor}`;
    const session = sessionOf(sessions, anchor.ecosystem);
    const answer = session.readBack
      ? await session.readBack(ref, version, was)
      : ({ kind: "unverifiable", reason: `the ${anchor.ecosystem} ecosystem has no registry to read it back from` } as const);
    if (answer.kind === "unverifiable") {
      findings.push({ key: unit.key, layer, kind: "unverifiable", detail: `${answer.reason}; its recorded digest is kept` });
      keep();
      continue;
    }
    verifiable = true;
    if (answer.kind === "absent") {
      if (was !== undefined) {
        findings.push({ key: unit.key, layer, kind: "drift", detail: `recorded at ${version}, which its registry does not serve` });
      }
      continue;
    }
    published = true;
    for (const drift of answer.drift) {
      findings.push({ key: unit.key, layer: drift, kind: "drift", detail: `the ledger disagrees with what is published at ${version}` });
    }
    (ecosystems[anchor.ecosystem] ??= {})[anchor.anchor] = answer.layer;
  }
  // A layer that cannot be read back is as published as its ledger says.
  if (kept || (!verifiable && recorded)) published = true;
  const payload = recorded?.payload;
  if (unit.payload && payload !== undefined) {
    findings.push({ key: unit.key, layer: "payload", kind: "unverifiable", detail: "a declared payload has no read-back; its recorded digest is kept" });
  }
  return { published, layers: { ecosystems, ...(payload !== undefined && unit.payload ? { payload } : {}) } };
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

/**
 * The tags `<unit key>@<version>` of what the last apply moved: every unit whose
 * final or candidate version in HEAD's ledger differs from its first parent's.
 * The apply must be committed — a tag on a commit that does not hold the
 * versions would name a release nothing can rebuild.
 */
export function tagsToCreate(host: ReleaseHost, workspace: ReleaseWorkspace): { tag: string; exists: boolean }[] {
  const at = (rev: string) => {
    const text = fileAt(workspace.root, rev, LEDGER_PATH);
    return text === undefined ? { units: new Map() } as Ledger : parseLedger(text, `${rev}:${LEDGER_PATH}`, host.ledger ?? {});
  };
  const working = readWorkspaceFile(workspace, LEDGER_PATH);
  if (working !== fileAt(workspace.root, "HEAD", LEDGER_PATH)) {
    throw new Error(
      `${LEDGER_PATH} differs from HEAD's, so the apply it records is not committed. Commit it, then tag: ` +
        `a tag must point at the commit holding the versions.`,
    );
  }
  const head = at("HEAD");
  const parent = at("HEAD^");
  const headSha = headCommit(workspace.root);
  const tags: { tag: string; exists: boolean }[] = [];
  for (const [key, entry] of [...head.units].sort(([a], [b]) => a.localeCompare(b))) {
    const before = parent.units.get(key);
    const moved: string[] = [];
    if (entry.version !== undefined && entry.version !== before?.version) moved.push(entry.version);
    if (entry.candidate && entry.candidate.version !== before?.candidate?.version) moved.push(entry.candidate.version);
    for (const version of moved) {
      const tag = `${key}@${version}`;
      const existing = tagCommit(workspace.root, tag);
      if (existing !== undefined && existing !== headSha) {
        throw new Error(`Tag '${tag}' already exists on ${existing.slice(0, 12)}, not on HEAD. A version is tagged once.`);
      }
      tags.push({ tag, exists: existing !== undefined });
    }
  }
  return tags;
}

export function createTags(workspace: ReleaseWorkspace, tags: readonly { tag: string; exists: boolean }[]): void {
  for (const { tag, exists } of tags) if (!exists) createTag(workspace.root, tag);
}

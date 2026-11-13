/**
 * Turning evidence into a release plan: which units bump, to what, and why.
 *
 * Three questions, three mechanisms:
 *
 * - **Whether** a unit bumps is decided by the digests of its layers at its
 *   recorded version against the ledger — exact, from the bytes, so it sees an
 *   inlined sibling and a lockfile-only bump that no path rule can.
 * - **At what level** is decided by the **edge graph**: a fragment is a root, and
 *   a dependent mirrors its dependency's level, joined as the maximum over
 *   paths. A group releases every member at the highest level any member needs.
 * - **Whether a changelog line is requested** is decided by whether a unit's own
 *   files changed; a unit that drifted with no fragment ships as an
 *   unattributed patch.
 *
 * Pure data in, plan out: edges arrive as data from the adapters and the
 * evidence, so this file reads no package format and names no ecosystem.
 */

import {
  applyBump,
  candidateVersion,
  compareVersions,
  isReleaseVersion,
  levelExceeds,
  levelOfKind,
  maxLevel,
  parseCandidateVersion,
  type BumpLevel,
  type FragmentKind,
} from "./bump-level.js";
import type { ReleaseFragment, UnitKey } from "./fragment.js";
import { diffLayers, type LayerChange, type Ledger, type LedgerEntry, type UnitLayers } from "./ledger.js";
import type { VersionReading } from "./units.js";

export interface UnitEvidence {
  /** Workspace-relative directory path — the unit's key everywhere. */
  readonly key: UnitKey;
  /** For display only. */
  readonly name?: string;
  /** The version the working copy carries, read from its version location. */
  readonly version: string;
  /** Per-layer integrity of the payload built from the working copy. */
  readonly layers: UnitLayers;
  /** The publish destination base these layers were built against, for an
   *  ecosystem whose bytes depend on it. */
  readonly registry?: string;
  /** Import edges the adapters found: units whose version this unit's payload
   *  names, so moving theirs moves its bytes. */
  readonly imports: readonly UnitKey[];
  /** Files of other units this unit's build inlined, grouped by owner — from a
   *  bundler metafile. */
  readonly inlines: ReadonlyMap<UnitKey, readonly string[]>;
  /** Workspace-relative files of this unit's payload, for the version-location
   *  edge rule. */
  readonly payloadFiles?: readonly string[];
  /** Workspace-relative files carrying this unit's version. */
  readonly versionFiles?: readonly string[];
  /** Every version location as read, for `UNIT_VERSION_MISMATCH`. */
  readonly versionReadings?: readonly VersionReading[];
  /** Whether a release-relevant file under the unit's own directory changed. */
  readonly ownFilesChanged: boolean;
  /** The highest bump allowed (`major` when absent). */
  readonly maxBump?: BumpLevel;
}

export interface ReleaseEvidence {
  readonly units: readonly UnitEvidence[];
  readonly ledger: Ledger;
  readonly fragments: readonly ReleaseFragment[];
  /** Named groups whose members share one version. */
  readonly groups?: ReadonlyMap<string, readonly UnitKey[]>;
}

export interface PlanOptions {
  /** Plan a candidate with this identifier (`rc`): each planned unit is
   *  versioned `<final>-<id>.<k>`, no fragment is consumed, and the final entry
   *  is left alone. */
  readonly candidate?: string;
}

/** Why a unit is in the plan. A unit usually carries several. */
export type BumpReason =
  | { readonly kind: "declared"; readonly fragment: string; readonly as: FragmentKind }
  | { readonly kind: "inlines"; readonly unit: UnitKey; readonly files: readonly string[] }
  | { readonly kind: "imports"; readonly unit: UnitKey }
  | { readonly kind: "version-location"; readonly unit: UnitKey; readonly files: readonly string[] }
  | { readonly kind: "group"; readonly group: string }
  | { readonly kind: "unattributed" };

export interface ChangelogEntry {
  readonly kind: FragmentKind;
  readonly body: string;
  /** The fragment this line came from. */
  readonly fragment: string;
}

export interface PlannedUnit {
  readonly key: UnitKey;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly level: BumpLevel;
  readonly reasons: readonly BumpReason[];
  /** Layers whose digest differs from the final entry's. */
  readonly changed: readonly LayerChange[];
  readonly entries: readonly ChangelogEntry[];
  readonly group?: string;
}

export interface ReleaseDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export interface ReleasePlan {
  /** Moving units in edge order — a dependency precedes its dependents. */
  readonly units: readonly PlannedUnit[];
  /** Fragments this plan consumes, for `apply` to delete. None for a candidate. */
  readonly fragments: readonly string[];
  readonly diagnostics: readonly ReleaseDiagnostic[];
  /** The candidate identifier, when this plans a candidate. */
  readonly candidate?: string;
}

/** An edge `from` → `to`: `from` must move when `to` does. */
interface Edge {
  readonly to: UnitKey;
  readonly reason: BumpReason;
  /** An import edge bumps unconditionally; an inline edge only explains drift. */
  readonly explainsDriftOnly: boolean;
}

export function planRelease(evidence: ReleaseEvidence, options: PlanOptions = {}): ReleasePlan {
  const diagnostics: ReleaseDiagnostic[] = [];
  const byKey = new Map(evidence.units.map((unit) => [unit.key, unit]));
  const groups = evidence.groups ?? new Map<string, readonly UnitKey[]>();
  const groupOf = new Map<UnitKey, string>();
  for (const [name, members] of groups) for (const member of members) groupOf.set(member, name);

  // What the digest says, per unit, against its FINAL entry. A unit with no
  // final entry has never been published, which is not drift.
  const drift = new Map<UnitKey, LayerChange[]>();
  for (const unit of evidence.units) {
    const mismatch = judgeUnitVersions(unit.key, unit.versionReadings ?? []);
    if (mismatch) diagnostics.push(mismatch);
    const recorded = evidence.ledger.units.get(unit.key);
    if (!recorded) continue;
    if (recorded.registry && unit.registry && recorded.registry !== unit.registry) {
      diagnostics.push({
        severity: "error",
        code: "LEDGER_REGISTRY_MISMATCH",
        message:
          `${unit.key}: its ledger digests were taken against '${recorded.registry}', but this ` +
          `run built against '${unit.registry}', so the two are digests of different bytes. ` +
          `Publish to the recorded base, or re-record with \`release verify --write\`.`,
      });
      continue;
    }
    if (unit.version !== recorded.version && unit.version !== recorded.candidate?.version) {
      diagnostics.push({
        severity: "error",
        code: "LEDGER_VERSION_MISMATCH",
        message:
          `${unit.key} carries version ${unit.version} but the ledger records ` +
          `${recorded.version ?? "no final version"}${
            recorded.candidate ? ` and candidate ${recorded.candidate.version}` : ""
          }. The digests beside it were taken at that version, so nothing here can be compared. ` +
          `Reconcile with \`release verify\` — or, if the version was moved by hand, restore it ` +
          `and let \`release apply\` move it.`,
      });
      continue;
    }
    if (recorded.version === undefined) continue;
    const changes = diffLayers(recorded.layers, unit.layers);
    if (changes.length > 0) drift.set(unit.key, changes);
  }

  const edges = edgesOf(evidence.units);
  const levels = new Map<UnitKey, BumpLevel>();
  const reasons = new Map<UnitKey, BumpReason[]>();
  const credited = new Set<string>();
  const addReason = (key: UnitKey, reason: BumpReason, id: string) => {
    if (credited.has(id)) return;
    credited.add(id);
    const list = reasons.get(key);
    if (list) list.push(reason);
    else reasons.set(key, [reason]);
  };

  // Declared roots.
  const consumed = new Set<string>();
  for (const fragment of evidence.fragments) {
    for (const [key, kind] of fragment.units) {
      if (!byKey.has(key)) {
        diagnostics.push({
          severity: "error",
          code: "FRAGMENT_UNKNOWN_UNIT",
          message:
            `${fragment.source} names '${key}', which is not a unit in this workspace. ` +
            `A fragment names a unit by its workspace-relative directory path.`,
        });
        continue;
      }
      const level = levelOfKind(kind);
      consumed.add(fragment.source);
      levels.set(key, maxLevel(levels.get(key) ?? level, level));
      addReason(key, { kind: "declared", fragment: fragment.source, as: kind }, `${key}\0declared\0${fragment.source}`);
    }
  }

  const settle = () => propagate(evidence.units, edges, drift, levels, groups, addReason);
  settle();
  // A payload that moved with nothing to attribute it to still ships, as a
  // named patch — and is itself a dependency move for anything importing it.
  for (;;) {
    let seeded = false;
    for (const unit of evidence.units) {
      if (levels.has(unit.key) || !drift.has(unit.key)) continue;
      levels.set(unit.key, "patch");
      addReason(unit.key, { kind: "unattributed" }, `${unit.key}\0unattributed`);
      seeded = true;
    }
    if (!seeded) break;
    settle();
  }

  for (const unit of evidence.units) {
    const level = levels.get(unit.key);
    const ceiling = unit.maxBump ?? "major";
    if (!level || !levelExceeds(level, ceiling)) continue;
    diagnostics.push({
      severity: "error",
      code: "MAX_BUMP_EXCEEDED",
      message:
        `${unit.key} needs a ${level} bump, above its maxBump of ${ceiling}. Because: ` +
        `${(reasons.get(unit.key) ?? []).map(describeReason).join("; ")}. Describe the change ` +
        `with a kind within ${ceiling}, or raise 'maxBump' in telo-workspace.yaml.`,
    });
  }

  const versions = planVersions(evidence, levels, groups, options);
  const entriesByUnit = collectChangelogEntries(evidence.fragments, byKey);
  requestMissingChangelogEntries(evidence.units, entriesByUnit, diagnostics);

  const planned: PlannedUnit[] = [];
  for (const unit of orderByEdges(evidence.units, edges)) {
    const level = levels.get(unit.key);
    const to = versions.get(unit.key);
    if (!level || to === undefined || to === unit.version) continue;
    const group = groupOf.get(unit.key);
    planned.push({
      key: unit.key,
      name: unit.name ?? unit.key,
      from: unit.version,
      to,
      level,
      reasons: reasons.get(unit.key) ?? [],
      changed: drift.get(unit.key) ?? [],
      entries: entriesByUnit.get(unit.key) ?? [],
      ...(group !== undefined ? { group } : {}),
    });
  }

  return {
    units: planned,
    fragments: options.candidate ? [] : [...consumed].sort(),
    diagnostics,
    ...(options.candidate ? { candidate: options.candidate } : {}),
  };
}

/** Import edges from the adapters, inline edges from a metafile, and the
 *  generic rule: another unit's version location inside this unit's payload. */
function edgesOf(units: readonly UnitEvidence[]): Map<UnitKey, Edge[]> {
  const edges = new Map<UnitKey, Edge[]>();
  const owners = new Map<string, UnitKey>();
  for (const unit of units) for (const file of unit.versionFiles ?? []) owners.set(file, unit.key);

  for (const unit of units) {
    const list: Edge[] = [];
    for (const to of unit.imports) {
      if (to !== unit.key) list.push({ to, reason: { kind: "imports", unit: to }, explainsDriftOnly: false });
    }
    for (const [to, files] of unit.inlines) {
      if (to !== unit.key) list.push({ to, reason: { kind: "inlines", unit: to, files }, explainsDriftOnly: true });
    }
    const located = new Map<UnitKey, string[]>();
    for (const file of unit.payloadFiles ?? []) {
      const owner = owners.get(file);
      if (owner === undefined || owner === unit.key) continue;
      const files = located.get(owner);
      if (files) files.push(file);
      else located.set(owner, [file]);
    }
    for (const [to, files] of located) {
      list.push({
        to,
        reason: { kind: "version-location", unit: to, files: files.sort() },
        explainsDriftOnly: false,
      });
    }
    edges.set(unit.key, list);
  }
  return edges;
}

/**
 * Raise levels along edges and across groups until nothing moves. An import or
 * version-location edge bumps unconditionally — moving the dependency's version
 * provably moves this payload, which the current digest cannot yet show. An
 * inline edge only explains drift that already showed up.
 */
function propagate(
  units: readonly UnitEvidence[],
  edges: ReadonlyMap<UnitKey, readonly Edge[]>,
  drift: ReadonlyMap<UnitKey, LayerChange[]>,
  levels: Map<UnitKey, BumpLevel>,
  groups: ReadonlyMap<string, readonly UnitKey[]>,
  addReason: (key: UnitKey, reason: BumpReason, id: string) => void,
): void {
  for (let moved = true; moved; ) {
    moved = false;
    for (const unit of units) {
      for (const edge of edges.get(unit.key) ?? []) {
        if (edge.explainsDriftOnly && !drift.has(unit.key)) continue;
        const from = levels.get(edge.to);
        if (!from) continue;
        addReason(unit.key, edge.reason, `${unit.key}\0${edge.to}\0${edge.reason.kind}`);
        moved = raise(levels, unit.key, from) || moved;
      }
    }
    for (const [name, members] of groups) {
      let level: BumpLevel | undefined;
      for (const member of members) {
        const own = levels.get(member);
        if (own) level = level ? maxLevel(level, own) : own;
      }
      if (!level) continue;
      for (const member of members) {
        if (!units.some((unit) => unit.key === member)) continue;
        if (raise(levels, member, level)) {
          addReason(member, { kind: "group", group: name }, `${member}\0group`);
          moved = true;
        }
      }
    }
  }
}

function raise(levels: Map<UnitKey, BumpLevel>, key: UnitKey, level: BumpLevel): boolean {
  const current = levels.get(key);
  const next = current ? maxLevel(current, level) : level;
  if (current === next) return false;
  levels.set(key, next);
  return true;
}

/**
 * The version each moving unit is planned at. A final is its recorded final
 * bumped by its level; a unit never published as a final is bumped from its own
 * version, unless that is already a candidate, whose final it keeps. A group's
 * members share the highest such final. A candidate appends `-<id>.<k>`, `k`
 * rising only when a layer differs from the unit's candidate record.
 */
function planVersions(
  evidence: ReleaseEvidence,
  levels: ReadonlyMap<UnitKey, BumpLevel>,
  groups: ReadonlyMap<string, readonly UnitKey[]>,
  options: PlanOptions,
): Map<UnitKey, string> {
  const finals = new Map<UnitKey, string>();
  for (const unit of evidence.units) {
    const level = levels.get(unit.key);
    if (!level) continue;
    const final = finalOf(unit, evidence.ledger.units.get(unit.key), level);
    if (final !== undefined) finals.set(unit.key, final);
  }
  for (const members of groups.values()) {
    const shared = members
      .map((member) => finals.get(member))
      .filter((v): v is string => v !== undefined)
      .sort(compareVersions)
      .pop();
    if (shared === undefined) continue;
    for (const member of members) if (finals.has(member)) finals.set(member, shared);
  }
  if (!options.candidate) return finals;

  const id = options.candidate;
  const ks = new Map<UnitKey, number>();
  for (const unit of evidence.units) {
    const final = finals.get(unit.key);
    if (final === undefined) continue;
    const record = evidence.ledger.units.get(unit.key)?.candidate;
    const previous = record ? parseCandidateVersion(record.version) : undefined;
    ks.set(
      unit.key,
      previous && previous.final === final && previous.id === id
        ? diffLayers(record!.layers, unit.layers).length === 0
          ? previous.k
          : previous.k + 1
        : 1,
    );
  }
  for (const members of groups.values()) {
    const shared = Math.max(0, ...members.map((member) => ks.get(member) ?? 0));
    for (const member of members) if (ks.has(member)) ks.set(member, shared);
  }
  const candidates = new Map<UnitKey, string>();
  for (const [key, final] of finals) candidates.set(key, candidateVersion(final, id, ks.get(key)!));
  return candidates;
}

function finalOf(unit: UnitEvidence, recorded: LedgerEntry | undefined, level: BumpLevel): string | undefined {
  if (recorded?.version !== undefined) return applyBump(recorded.version, level);
  const candidate = parseCandidateVersion(unit.version);
  if (candidate) return candidate.final;
  return isReleaseVersion(unit.version) ? applyBump(unit.version, level) : undefined;
}

/** `UNIT_VERSION_MISMATCH` when a unit's version locations disagree or one
 *  holds no version. */
export function judgeUnitVersions(
  key: UnitKey,
  readings: readonly VersionReading[],
): ReleaseDiagnostic | undefined {
  const values = new Set(readings.map((reading) => reading.value));
  if (readings.length === 0 || (values.size === 1 && !values.has(undefined))) return undefined;
  return {
    severity: "error",
    code: "UNIT_VERSION_MISMATCH",
    message:
      `${key}: its version locations disagree — ${readings
        .map(
          (reading) =>
            `${reading.pointer ? `${reading.file}#${reading.pointer}` : reading.file} ` +
            (reading.value !== undefined ? `holds ${reading.value}` : `holds no version${reading.error ? ` (${reading.error})` : ""}`),
        )
        .join(", ")}. A unit has one version; restore the moved one and let \`release apply\` move them together.`,
  };
}

function describeReason(reason: BumpReason): string {
  switch (reason.kind) {
    case "declared":
      return `${reason.fragment} declares ${reason.as}`;
    case "imports":
      return `it imports ${reason.unit}`;
    case "inlines":
      return `it inlines ${reason.unit}`;
    case "version-location":
      return `its payload holds ${reason.unit}'s version`;
    case "group":
      return `it shares group '${reason.group}'`;
    case "unattributed":
      return "its payload moved";
  }
}

function collectChangelogEntries(
  fragments: readonly ReleaseFragment[],
  byKey: ReadonlyMap<UnitKey, UnitEvidence>,
): Map<UnitKey, ChangelogEntry[]> {
  const entries = new Map<UnitKey, ChangelogEntry[]>();
  for (const fragment of fragments) {
    for (const [key, kind] of fragment.units) {
      if (!byKey.has(key)) continue;
      const list = entries.get(key);
      const entry: ChangelogEntry = { kind, body: fragment.body, fragment: fragment.source };
      if (list) list.push(entry);
      else entries.set(key, [entry]);
    }
  }
  return entries;
}

/**
 * Ask for prose where a unit's own files changed with no fragment — a warning,
 * since the digest still releases the change, and ONE warning naming them all,
 * since one fragment can name them all.
 */
function requestMissingChangelogEntries(
  units: readonly UnitEvidence[],
  entries: ReadonlyMap<UnitKey, ChangelogEntry[]>,
  diagnostics: ReleaseDiagnostic[],
): void {
  const missing = units.filter((unit) => unit.ownFilesChanged && !entries.has(unit.key)).map((unit) => unit.key);
  if (missing.length === 0) return;
  diagnostics.push({
    severity: "warning",
    code: "CHANGELOG_ENTRY_REQUESTED",
    message:
      `${missing.length} unit(s) have their own changes but no fragment describes them, so ` +
      `their changelogs will not mention this release: ${missing.join(", ")}. ` +
      `One \`release add\` can name them all.`,
  });
}

/**
 * Edge order — a dependency before its dependents, which is also the publish
 * order. A cycle keeps its members in key order rather than throwing.
 */
function orderByEdges(units: readonly UnitEvidence[], edges: ReadonlyMap<UnitKey, readonly Edge[]>): UnitEvidence[] {
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const ordered: UnitEvidence[] = [];
  const state = new Map<UnitKey, "visiting" | "done">();
  const visit = (key: UnitKey): void => {
    const unit = byKey.get(key);
    if (!unit || state.get(key)) return;
    state.set(key, "visiting");
    for (const to of [...new Set((edges.get(key) ?? []).map((edge) => edge.to))].sort()) visit(to);
    state.set(key, "done");
    ordered.push(unit);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  return ordered;
}

/** Units in import order — a dependency before its dependents. */
export function orderByImports<T extends { readonly key: UnitKey; readonly imports: readonly UnitKey[] }>(
  units: readonly T[],
): T[] {
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const ordered: T[] = [];
  const state = new Map<UnitKey, "visiting" | "done">();
  const visit = (key: UnitKey): void => {
    const unit = byKey.get(key);
    if (!unit || state.get(key)) return;
    state.set(key, "visiting");
    for (const to of [...unit.imports].sort()) visit(to);
    state.set(key, "done");
    ordered.push(unit);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  return ordered;
}

/** What a unit's layers read after `apply` wrote its version. */
export interface RecordedReading {
  readonly layers: UnitLayers;
  readonly registry?: string;
}

/**
 * The ledger after `apply`. A final plan records each moved unit's final entry
 * and removes every candidate record; a candidate plan records each moved unit's
 * candidate beside its untouched final entry.
 */
export function recordRelease(
  ledger: Ledger,
  plan: ReleasePlan,
  readings: ReadonlyMap<UnitKey, RecordedReading>,
): Ledger {
  const units = new Map<UnitKey, LedgerEntry>();
  for (const [key, entry] of ledger.units) {
    if (plan.candidate) units.set(key, entry);
    else if (entry.version !== undefined) {
      units.set(key, {
        version: entry.version,
        ...(entry.registry ? { registry: entry.registry } : {}),
        layers: entry.layers,
      });
    }
  }
  for (const unit of plan.units) {
    const reading = readings.get(unit.key);
    if (!reading) continue;
    const existing = units.get(unit.key);
    if (plan.candidate) {
      units.set(unit.key, {
        ...(existing ?? { layers: { ecosystems: {} } }),
        ...(reading.registry && !existing?.registry ? { registry: reading.registry } : {}),
        candidate: { version: unit.to, layers: reading.layers },
      });
    } else {
      units.set(unit.key, {
        version: unit.to,
        ...(reading.registry ? { registry: reading.registry } : {}),
        layers: reading.layers,
      });
    }
  }
  return { units };
}

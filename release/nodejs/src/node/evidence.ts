/**
 * The evidence half of an ecosystem, and the collection that turns a workspace
 * into the planner's `UnitEvidence`.
 *
 * An adapter's pure half says what an anchor is and where its version lives; its
 * evidence half — registered beside it by the host program — builds the anchor's
 * layer as a file set, finds its import edges, names where it publishes, and
 * reads a published layer back. The collection here asks each anchor's half and
 * adds what no adapter owns: the declared `payload:` layer, `metafile:` inline
 * edges, every version location read, and whether the unit's own files changed.
 */

import { lastMatchIndex } from "@telorun/glob";
import type { UnitKey } from "../fragment.js";
import type { AnchorDigest, Ledger, UnitLayers } from "../ledger.js";
import type { ReleaseDiagnostic, ReleasePlan, UnitEvidence } from "../release-plan.js";
import { readUnitVersions, type ResolvedAnchor, type ResolvedUnit } from "../units.js";
import { declaredPayload } from "./declared-payload.js";
import { changedFilesSinceBase } from "./git.js";
import { metafileInlines } from "./metafile.js";
import type { ReleaseWorkspace } from "./workspace.js";

export interface SessionOptions {
  readonly ledger: Ledger;
  /** The command's parsed options, for a host's own (`--registry`). */
  readonly argv: Readonly<Record<string, unknown>>;
}

/** One anchor of one unit. */
export interface AnchorRef {
  readonly unit: ResolvedUnit;
  readonly anchor: ResolvedAnchor;
}

export interface AnchorEvidence {
  /** The anchor's layer; absent when it contributes none (a private package). */
  readonly layer?: AnchorDigest;
  /** Workspace-relative files the layer holds, for the version-location edge. */
  readonly files?: readonly string[];
  /** Units whose version this anchor's payload names. */
  readonly imports?: readonly UnitKey[];
  /** Files of other units this anchor's build inlined, by owner. */
  readonly inlines?: ReadonlyMap<UnitKey, readonly string[]>;
  /** The publish base the layer was built against, when its bytes depend on it. */
  readonly registry?: string;
}

export type ReadBack =
  /** Nothing to read the layer back from (a crate that is never published). */
  | { readonly kind: "unverifiable"; readonly reason: string }
  | { readonly kind: "absent" }
  | {
      readonly kind: "published";
      /** What the ledger records for the anchor once reconciled. */
      readonly layer: AnchorDigest;
      /** The layers on which the recorded digest disagrees with the registry. */
      readonly drift: readonly string[];
    };

/** One workspace's evidence for one ecosystem. */
export interface EvidenceSession {
  /** What is wrong before any layer is built: unresolvable destinations, a
   *  graph that cannot be read. */
  readonly diagnostics?: readonly ReleaseDiagnostic[];
  collect(ref: AnchorRef): Promise<AnchorEvidence>;
  /** Import edges alone, cheaply, for `order`. */
  imports(ref: AnchorRef): Promise<readonly UnitKey[]>;
  /** The publish base the anchor's bytes are built against, recorded beside its
   *  ledger entry, for an ecosystem whose bytes depend on it. */
  registry?(ref: AnchorRef): string | undefined;
  /** Where the anchor publishes; `undefined` when the cascade names nothing. */
  destination?(ref: AnchorRef): string | undefined;
  /** The anchor's layer as published at `version`. Absent: no read-back. */
  readBack?(ref: AnchorRef, version: string, recorded: AnchorDigest | undefined): Promise<ReadBack>;
  /** Every version published, for seeding a candidate's final entry. */
  publishedVersions?(ref: AnchorRef): Promise<readonly string[]>;
  /** Writes `apply` makes beside the version locations once the unit carries
   *  `version` (a dependent's range, a manifest's self pin), workspace-relative. */
  afterStamp?(ref: AnchorRef, version: string, plan: ReleasePlan): Promise<readonly string[]>;
}

export interface EvidenceAdapter {
  readonly ecosystem: string;
  /** An anchor of it publishes to a destination its settings must name, so one
   *  naming none is `NO_DESTINATION_KNOWN`. */
  readonly needsDestination?: boolean;
  open(workspace: ReleaseWorkspace, options: SessionOptions): Promise<EvidenceSession>;
}

export type Sessions = ReadonlyMap<string, EvidenceSession>;

export async function openSessions(
  workspace: ReleaseWorkspace,
  adapters: readonly EvidenceAdapter[],
  options: SessionOptions,
): Promise<Map<string, EvidenceSession>> {
  const used = new Set(workspace.units.flatMap((unit) => unit.anchors.map((anchor) => anchor.ecosystem)));
  const sessions = new Map<string, EvidenceSession>();
  for (const adapter of adapters) {
    if (used.has(adapter.ecosystem)) sessions.set(adapter.ecosystem, await adapter.open(workspace, options));
  }
  return sessions;
}

export function sessionOf(sessions: Sessions, ecosystem: string): EvidenceSession {
  const session = sessions.get(ecosystem);
  if (!session) {
    throw new Error(`No evidence is registered for the '${ecosystem}' ecosystem in this host, so its layers cannot be built.`);
  }
  return session;
}

/** Whether an anchor publishes something of its own: an `order` row, a layer. */
export function publishes(anchor: ResolvedAnchor): boolean {
  return anchor.package.contributesLayer;
}

/** `NO_DESTINATION_KNOWN` and destination collisions, across every row. */
export function destinationDiagnostics(
  workspace: ReleaseWorkspace,
  adapters: readonly EvidenceAdapter[],
  sessions: Sessions,
): ReleaseDiagnostic[] {
  const diagnostics: ReleaseDiagnostic[] = [];
  const claimed = new Map<string, string>();
  for (const unit of workspace.units) {
    for (const anchor of unit.anchors) {
      if (!publishes(anchor)) continue;
      const session = sessions.get(anchor.ecosystem);
      const destination = session?.destination?.({ unit, anchor });
      const row = `${unit.key} (${anchor.ecosystem} at ${anchor.anchor})`;
      if (destination === undefined) {
        if (adapters.find((adapter) => adapter.ecosystem === anchor.ecosystem)?.needsDestination) {
          diagnostics.push({
            severity: "error",
            code: "NO_DESTINATION_KNOWN",
            message:
              `${row} publishes, but nothing names where: no 'registry' at the anchor ` +
              `(ecosystem: { ${anchor.ecosystem}: { ${JSON.stringify(anchor.anchor)}: { registry: … } } }) or under ` +
              `'release.ecosystems.${anchor.ecosystem}'.`,
          });
        }
        continue;
      }
      const other = claimed.get(destination);
      if (other !== undefined) {
        diagnostics.push({
          severity: "error",
          code: "DESTINATION_COLLISION",
          message: `${other} and ${row} both publish to '${destination}'. Give one of them another name or registry.`,
        });
        continue;
      }
      claimed.set(destination, row);
    }
  }
  return diagnostics;
}

export interface CollectOptions {
  readonly baseRef: string;
  readonly onUnit?: (unit: ResolvedUnit, index: number, total: number) => void;
  /** Collect these units only; every other unit gets no layers. */
  readonly only?: ReadonlySet<UnitKey>;
}

export async function collectEvidence(
  workspace: ReleaseWorkspace,
  sessions: Sessions,
  options: CollectOptions,
): Promise<UnitEvidence[]> {
  const changed = changedUnits(workspace, options.baseRef);
  const units = workspace.units.filter((unit) => !options.only || options.only.has(unit.key));
  const evidence: UnitEvidence[] = [];
  for (const [index, unit] of units.entries()) {
    options.onUnit?.(unit, index, units.length);
    evidence.push(await unitEvidence(workspace, sessions, unit, changed.has(unit.key)));
  }
  return evidence;
}

/** One unit's layers, as `apply` records them and `collectEvidence` reads them. */
export async function unitEvidence(
  workspace: ReleaseWorkspace,
  sessions: Sessions,
  unit: ResolvedUnit,
  ownFilesChanged: boolean,
): Promise<UnitEvidence> {
  const ecosystems: Record<string, Record<string, AnchorDigest>> = {};
  const payloadFiles = new Set<string>();
  const imports = new Set<UnitKey>();
  const inlines = new Map<UnitKey, Set<string>>();
  let registry: string | undefined;
  for (const anchor of unit.anchors) {
    const found = await sessionOf(sessions, anchor.ecosystem).collect({ unit, anchor });
    if (found.layer !== undefined) (ecosystems[anchor.ecosystem] ??= {})[anchor.anchor] = found.layer;
    for (const file of found.files ?? []) payloadFiles.add(file);
    for (const key of found.imports ?? []) if (key !== unit.key) imports.add(key);
    for (const [key, files] of found.inlines ?? []) addInlines(inlines, key, files);
    registry ??= found.registry;
  }
  let payload: string | undefined;
  if (unit.payload) {
    const declared = declaredPayload(workspace.root, unit);
    payload = declared.digest;
    for (const file of declared.files) payloadFiles.add(file);
  }
  if (unit.metafile) {
    for (const [key, files] of metafileInlines(workspace, unit)) addInlines(inlines, key, files);
  }
  const readings = readUnitVersions(unit, (relative) => workspace.tree.readFile(relative), workspace.adapters);
  const primary = readings[0];
  const layers: UnitLayers = { ecosystems, ...(payload !== undefined ? { payload } : {}) };
  return {
    key: unit.key,
    ...(unit.anchors[0]?.package.name ? { name: unit.anchors[0].package.name } : {}),
    version: primary?.value ?? "",
    layers,
    ...(registry ? { registry } : {}),
    imports: [...imports].sort(),
    inlines: new Map([...inlines].map(([key, files]) => [key, [...files].sort()])),
    payloadFiles: [...payloadFiles].sort(),
    versionFiles: [...new Set(unit.versionLocations.map((location) => location.file))],
    versionReadings: readings,
    ownFilesChanged,
    maxBump: unit.maxBump,
  };
}

function addInlines(into: Map<UnitKey, Set<string>>, key: UnitKey, files: Iterable<string>): void {
  const set = into.get(key) ?? new Set<string>();
  for (const file of files) set.add(file);
  into.set(key, set);
}

/** The unit owning a workspace-relative path: the nearest enclosing unit. */
export function owningUnit(units: readonly ResolvedUnit[], file: string): ResolvedUnit | undefined {
  let best: ResolvedUnit | undefined;
  for (const unit of units) {
    const inside = unit.dir === "" || file === unit.dir || file.startsWith(`${unit.dir}/`);
    if (inside && (!best || unit.dir.length > best.dir.length)) best = unit;
  }
  return best;
}

/**
 * Units with a change of their own since the base: attributed to the nearest
 * enclosing unit, less what its `ignore` list leaves out. No merge base (a
 * shallow clone) means the reading cannot be taken, and nothing is requested —
 * the digest is unaffected, since it compares against the ledger.
 */
function changedUnits(workspace: ReleaseWorkspace, baseRef: string): Set<UnitKey> {
  let files: string[];
  try {
    files = changedFilesSinceBase(workspace.root, baseRef);
  } catch {
    return new Set();
  }
  const changed = new Set<UnitKey>();
  for (const file of files) {
    const unit = owningUnit(workspace.units, file);
    if (!unit) continue;
    const rest = unit.dir === "" ? file : file.slice(unit.dir.length + 1);
    const ignored = lastMatchIndex(rest, unit.ignore);
    if (ignored >= 0 && !unit.ignore[ignored]!.startsWith("!")) continue;
    changed.add(unit.key);
  }
  return changed;
}

/**
 * Turning evidence into a release plan: which modules bump, to what, and why.
 *
 * Three questions, three mechanisms, and keeping them apart is the whole design:
 *
 * - **Whether** a module bumps is decided by the **payload digest** — exact,
 *   from the bytes, so it sees an inlined sibling and a lockfile-only transitive
 *   bump that no path-scoped rule can.
 * - **At what level** is decided by the **edge graph** — a declared fragment is a
 *   root, and a dependent mirrors its dependency's level, joined as the maximum
 *   over paths, because a module that inlines a breaking change is breaking for
 *   its own consumers.
 * - **Whether a changelog line is requested** is decided by the path-scoped
 *   changed-files rule, which used to decide the version. Demoted, its guesswork
 *   costs one sentence rather than a spurious republish.
 *
 * The seam between digest and graph is *reported*, never papered over: a payload
 * that moved with nothing to attribute it to — a third-party dependency, a
 * changesets-owned package inlined into a module, a toolchain bump — resolves to
 * `patch` and says so.
 *
 * Pure data in, plan out. Everything Node-shaped — building payloads, running
 * the controller builder, reading git — is the CLI's half, so the editor can
 * answer "what does changing this library bump?" from the same model.
 */

import {
  applyBump,
  maxLevel,
  type BumpLevel,
  type FragmentKind,
  levelOfKind,
} from "./bump-level.js";
import type { ModuleKey, ReleaseFragment } from "./fragment.js";
import type { Ledger } from "./ledger.js";
import { diffLayerDigests, type LayerChange, type LayerDigests } from "./payload-digest.js";

/** What a module ships. A `Dockerfile` beside the manifest makes it an image
 *  module; its absence, a registry artifact module. Derived rather than
 *  declared, so discovery stays configuration-free. */
export type ArtifactKind = "registry" | "image";

export interface ModuleEvidence {
  /** Workspace-relative directory path — the module's key everywhere. */
  readonly key: ModuleKey;
  /** `metadata.name`, for display only. */
  readonly name: string;
  /** `metadata.version` as it stands in the working copy. */
  readonly version: string;
  readonly artifactKind: ArtifactKind;
  /** Per-layer integrity of the payload built from the working copy. */
  readonly layers: LayerDigests;
  /**
   * Files this module's build inlined that belong to ANOTHER workspace module,
   * grouped by owner. From the build's own metafile: a declared-dependency graph
   * cannot see `--external`, so `@telorun/sdk` — declared by 54 modules, inlined
   * by none — would otherwise bump the whole standard library on every SDK
   * change.
   */
  readonly inlines: ReadonlyMap<ModuleKey, readonly string[]>;
  /**
   * Modules reached by an in-repo **relative** `imports:` source. A pinned
   * registry ref is deliberately not an edge: pinning is the statement "I am not
   * affected until I choose to be", and moving it is `telo upgrade`'s job.
   */
  readonly imports: readonly ModuleKey[];
  /** Whether a file under this module's own directory that reaches the artifact
   *  changed. Decides only whether a changelog line is requested. */
  readonly ownFilesChanged: boolean;
}

export interface ReleaseEvidence {
  readonly modules: readonly ModuleEvidence[];
  readonly ledger: Ledger;
  readonly fragments: readonly ReleaseFragment[];
  /** The publish destination base the digests above were built against. */
  readonly registry?: string;
}

/** Why a module is in the plan. A module usually carries several. */
export type BumpReason =
  | { readonly kind: "declared"; readonly fragment: string; readonly as: FragmentKind }
  | { readonly kind: "inlines"; readonly module: ModuleKey; readonly files: readonly string[] }
  | { readonly kind: "imports"; readonly module: ModuleKey }
  | { readonly kind: "unattributed" };

export interface ChangelogEntry {
  readonly kind: FragmentKind;
  readonly body: string;
  /** The fragment this line came from, so `apply` can report what it consumed. */
  readonly fragment: string;
}

export interface PlannedModule {
  readonly key: ModuleKey;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly level: BumpLevel;
  readonly reasons: readonly BumpReason[];
  /** Layers whose digest differs from the ledger's reading. Empty for a module
   *  bumping purely because a dependency's version moves into its manifest. */
  readonly changed: readonly LayerChange[];
  readonly entries: readonly ChangelogEntry[];
}

export interface ReleaseDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export interface ReleasePlan {
  /** Bumping modules in dependency order — a dependency precedes its
   *  dependents, which is also the order `telo publish` must push them. */
  readonly modules: readonly PlannedModule[];
  /** Fragments this plan consumes, for `apply` to delete. */
  readonly fragments: readonly string[];
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

export function planRelease(evidence: ReleaseEvidence): ReleasePlan {
  const diagnostics: ReleaseDiagnostic[] = [];
  const byKey = new Map(evidence.modules.map((module) => [module.key, module]));

  checkRegistryAgreement(evidence, diagnostics);

  // What the digest says, per module. A module with no ledger entry has never
  // been published, which is not drift — there is nothing to differ from.
  const drift = new Map<ModuleKey, LayerChange[]>();
  for (const module of evidence.modules) {
    const recorded = evidence.ledger.modules.get(module.key);
    if (!recorded) continue;
    if (recorded.version !== module.version) {
      diagnostics.push({
        severity: "error",
        code: "LEDGER_VERSION_MISMATCH",
        message:
          `${module.key} declares version ${module.version} but the ledger records ` +
          `${recorded.version} as published. The digests beside it were taken at that version, ` +
          `so nothing here can be compared. Reconcile with \`telo release verify\` — or, if the ` +
          `version was moved by hand, restore it and let \`telo release apply\` move it.`,
      });
      continue;
    }
    const changes = diffLayerDigests(recorded.layers, module.layers);
    if (changes.length > 0) drift.set(module.key, changes);
  }

  const levels = new Map<ModuleKey, BumpLevel>();
  const reasons = new Map<ModuleKey, BumpReason[]>();
  const addReason = (key: ModuleKey, reason: BumpReason) => {
    const list = reasons.get(key);
    if (list) list.push(reason);
    else reasons.set(key, [reason]);
  };

  // Declared roots.
  const consumed = new Set<string>();
  for (const fragment of evidence.fragments) {
    for (const [key, kind] of fragment.modules) {
      if (!byKey.has(key)) {
        diagnostics.push({
          severity: "error",
          code: "FRAGMENT_UNKNOWN_MODULE",
          message:
            `${fragment.source} names '${key}', which is not a module in this workspace. ` +
            `A fragment names a module by its workspace-relative directory path.`,
        });
        continue;
      }
      const level = levelOfKind(kind);
      if (level === "major") {
        diagnostics.push({
          severity: "error",
          code: "MAJOR_BUMP_REJECTED",
          message:
            `${fragment.source} declares '${key}: ${kind}', which induces a major bump. ` +
            `Modules are intentionally pre-1.0 — a breaking change ships as a minor. ` +
            `Use Added and describe the break in the body.`,
        });
        continue;
      }
      consumed.add(fragment.source);
      levels.set(key, maxLevel(levels.get(key) ?? level, level));
      addReason(key, { kind: "declared", fragment: fragment.source, as: kind });
    }
  }

  // Edges already credited, so a second propagation pass does not repeat an
  // explanation the author has already been given.
  const credited = new Set<string>();
  propagateToFixedPoint(evidence.modules, drift, levels, credited, addReason);

  // The seam. A payload that moved with nothing to attribute it to still has to
  // ship — the fix would otherwise reach nobody — so it takes a patch and is
  // named. Seeded after propagation and then propagated again, because an
  // unattributed bump is itself a dependency move for anything importing it.
  for (;;) {
    let seeded = false;
    for (const module of evidence.modules) {
      if (levels.has(module.key) || !drift.has(module.key)) continue;
      levels.set(module.key, "patch");
      addReason(module.key, { kind: "unattributed" });
      seeded = true;
    }
    if (!seeded) break;
    propagateToFixedPoint(evidence.modules, drift, levels, credited, addReason);
  }

  const entriesByModule = collectChangelogEntries(evidence.fragments, byKey);
  requestMissingChangelogEntries(evidence.modules, entriesByModule, diagnostics);

  const planned: PlannedModule[] = [];
  for (const module of orderByImports(evidence.modules)) {
    const level = levels.get(module.key);
    if (!level) continue;
    planned.push({
      key: module.key,
      name: module.name,
      from: module.version,
      to: applyBump(module.version, level),
      level,
      reasons: reasons.get(module.key) ?? [],
      changed: drift.get(module.key) ?? [],
      entries: entriesByModule.get(module.key) ?? [],
    });
  }

  return { modules: planned, fragments: [...consumed].sort(), diagnostics };
}

/**
 * Raise levels along release edges until nothing moves.
 *
 * The two edge kinds answer different questions and so are gated differently:
 *
 * - An **import** edge bumps unconditionally. Publishing rewrites a relative
 *   `imports:` source to `<base>/<sibling>@<version>`, so when the sibling's
 *   version moves this module's manifest layer provably changes — a fact about
 *   the plan, which the current digest cannot yet show because it was taken
 *   against the sibling's *current* version.
 * - An **inline** edge only explains drift that already showed up. The inlined
 *   bytes are in this payload, so if they had changed the digest would say so;
 *   attributing without that check would bump every dependent of a module whose
 *   fragment covers a docs-only change.
 */
function propagateToFixedPoint(
  modules: readonly ModuleEvidence[],
  drift: ReadonlyMap<ModuleKey, LayerChange[]>,
  levels: Map<ModuleKey, BumpLevel>,
  credited: Set<string>,
  addReason: (key: ModuleKey, reason: BumpReason) => void,
): void {
  for (let moved = true; moved; ) {
    moved = false;
    for (const module of modules) {
      for (const dependency of module.imports) {
        moved = raise(module, dependency, { kind: "imports", module: dependency }) || moved;
      }
      if (!drift.has(module.key)) continue;
      for (const [dependency, files] of module.inlines) {
        moved =
          raise(module, dependency, { kind: "inlines", module: dependency, files }) || moved;
      }
    }
  }

  function raise(module: ModuleEvidence, dependency: ModuleKey, reason: BumpReason): boolean {
    const from = levels.get(dependency);
    if (!from) return false;
    const current = levels.get(module.key);
    const next = current ? maxLevel(current, from) : from;
    // The reason is recorded the first time this edge carries anything, even
    // when it does not raise the level: it is the explanation the author reads,
    // and an edge that merely agrees with another still says why this module is
    // in the plan.
    const edge = `${module.key}\0${dependency}\0${reason.kind}`;
    if (!credited.has(edge)) {
      credited.add(edge);
      addReason(module.key, reason);
    }
    if (current === next) return false;
    levels.set(module.key, next);
    return true;
  }
}

function collectChangelogEntries(
  fragments: readonly ReleaseFragment[],
  byKey: ReadonlyMap<ModuleKey, ModuleEvidence>,
): Map<ModuleKey, ChangelogEntry[]> {
  const entries = new Map<ModuleKey, ChangelogEntry[]>();
  for (const fragment of fragments) {
    for (const [key, kind] of fragment.modules) {
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
 * Ask for prose where a human made a semantic change.
 *
 * A warning, not an error: `check`'s job is "can a complete, consistent plan be
 * formed", and a module that drifted through propagation or a toolchain bump is
 * planned and released without anyone writing a word. This fires only for a
 * module whose OWN files moved, which is the case where the changelog would
 * otherwise be silent about a real change.
 */
function requestMissingChangelogEntries(
  modules: readonly ModuleEvidence[],
  entries: ReadonlyMap<ModuleKey, ChangelogEntry[]>,
  diagnostics: ReleaseDiagnostic[],
): void {
  const missing = modules
    .filter((module) => module.ownFilesChanged && !entries.has(module.key))
    .map((module) => module.key);
  if (missing.length === 0) return;

  // ONE diagnostic listing the modules, not one per module. A change that
  // touches every module's build script or a shared config asks the same
  // question about forty of them at once, and forty copies of one sentence bury
  // the plan they are printed beside — the more so because they go to stderr
  // while the plan goes to stdout, so a piped run interleaves them.
  //
  // The fix for all of them is also one fragment, since a fragment names as many
  // modules as it likes.
  diagnostics.push({
    severity: "warning",
    code: "CHANGELOG_ENTRY_REQUESTED",
    message:
      `${missing.length} module(s) have their own changes but no fragment describes them, so ` +
      `their changelogs will not mention this release: ${missing.join(", ")}. ` +
      `One \`telo release add\` can name them all.`,
  });
}

/**
 * The base the digests were built against has to be the base they were recorded
 * against, or the manifest layers are not comparable: canonicalization writes
 * the destination into them.
 */
function checkRegistryAgreement(
  evidence: ReleaseEvidence,
  diagnostics: ReleaseDiagnostic[],
): void {
  const recorded = evidence.ledger.registry;
  if (!recorded || !evidence.registry || recorded === evidence.registry) return;
  diagnostics.push({
    severity: "error",
    code: "LEDGER_REGISTRY_MISMATCH",
    message:
      `The ledger's digests were taken against '${recorded}', but this run built against ` +
      `'${evidence.registry}'. Publishing rewrites each relative import to ` +
      `'<base>/<sibling>@<version>', so the manifest layers of the two are different bytes ` +
      `and comparing them would report every module as changed.`,
  });
}

/**
 * Dependency order over in-repo imports — a dependency before its dependents.
 *
 * This is also the publish order, and it is not optional there: publishing
 * canonicalizes a relative import and then hard-fails when the derived ref does
 * not already resolve, so a sibling has to be pushed first.
 *
 * A cycle keeps its members in key order rather than throwing. A module graph
 * should not have one, but a release is the wrong moment to discover it, and the
 * ordering degrades to "arbitrary among the cycle" rather than to nothing.
 */
export function orderByImports(modules: readonly ModuleEvidence[]): ModuleEvidence[] {
  const byKey = new Map(modules.map((module) => [module.key, module]));
  const ordered: ModuleEvidence[] = [];
  const state = new Map<ModuleKey, "visiting" | "done">();

  const visit = (key: ModuleKey): void => {
    const module = byKey.get(key);
    if (!module || state.get(key)) return;
    state.set(key, "visiting");
    for (const dependency of [...module.imports].sort()) visit(dependency);
    state.set(key, "done");
    ordered.push(module);
  };

  for (const key of [...byKey.keys()].sort()) visit(key);
  return ordered;
}

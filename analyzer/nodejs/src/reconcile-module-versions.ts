import type { ImportEdge, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import {
  compareParsedModuleVersions,
  parseModuleVersion,
  type ParsedModuleVersion,
} from "./module-version-order.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** Outcome of reconciling a module name that appears at more than one resolved
 *  source in a single import graph. The `overrides` map redirects each losing
 *  canonical URL to the winner's canonical URL — consulted by the runtime when
 *  it independently re-resolves an import (the analyzer side is handled by
 *  repointing `importEdges` in place). */
export interface VersionReconciliation {
  /** Loser canonical source URL → winner canonical source URL. */
  overrides: Map<string, string>;
  /** One diagnostic per import edge that pointed at a non-winner: a warning for
   *  a same-major hoist, an error for an incompatible major mismatch. */
  diagnostics: AnalysisDiagnostic[];
}

interface ModuleIdentity {
  source: string;
  identity: string;
  version: string;
  /** `null` for an unparseable version, which forces the group onto the
   *  conflict path — we never silently hoist across a version we can't reason
   *  about. */
  parsed: ParsedModuleVersion | null;
  text: string;
}

/** The location identity of an import ref: the ref with its version stripped.
 *  Two refs share an identity when they address the same module at different
 *  versions, whatever transport owns them:
 *
 *    "std/kv-store@0.3.0"             → "std/kv-store"
 *    "oci://ghcr.io/acme/s3@1.2.0"    → "oci://ghcr.io/acme/s3"
 *    "https://x.com/lib/telo.yaml"    → itself (a URL carries no version)
 *
 *  Returns `null` for a relative path, which addresses one file on the
 *  publisher's disk and is therefore not a cross-import key: two local libraries
 *  that merely agree on `metadata.name` are distinct modules, and reconciling
 *  them would drop one and break its kinds. The same local file reached via two
 *  paths is already collapsed by canonical-source dedup.
 *
 *  **What this key cannot relate.** It compares ref *spellings*, so it groups by
 *  origin exactly and nothing else. Two consequences, both accepted:
 *
 *  - A module imported once by an `oci://` ref and once by a relative path is
 *    two groups, so a version skew between them is not hoisted. Keying on what
 *    the module declares about itself would catch that case, but only by
 *    trusting a self-declared identity — which is what this change removes, and
 *    which cannot tell two same-named modules from different origins apart.
 *  - An `oci://` ref and a direct `https://…/telo.yaml` URL serving the same
 *    module are two groups. Relating them needs knowledge of the origin's
 *    layout, which this pure, browser-safe function does not have. */
function refIdentity(ref: string): string | null {
  const base = ref.split("#")[0];
  if (!base || base.startsWith(".") || base.startsWith("/") || base.startsWith("file:")) {
    return null;
  }
  const lastSlash = base.lastIndexOf("/");
  const at = base.lastIndexOf("@");
  return at > lastSlash && at > 0 ? base.slice(0, at) : base;
}

/** Read a loaded module's version and raw owner text under the location
 *  identity the import edge reached it by. The identity comes from the ref, not
 *  from anything the module declares about itself — a module's own metadata
 *  cannot distinguish two same-named modules published to different origins. */
function moduleIdentityOf(mod: LoadedModule, identity: string): ModuleIdentity | null {
  const doc = mod.owner.manifests.find((m) => m && isModuleKind(m.kind));
  if (!doc) return null;
  const meta = doc.metadata as { name?: string; version?: string };
  if (typeof meta?.name !== "string" || meta.name.length === 0) return null;
  const version = typeof meta.version === "string" ? meta.version : "";
  return {
    source: mod.owner.source,
    identity,
    version,
    parsed: parseModuleVersion(version),
    text: mod.owner.text,
  };
}

interface GroupResolution {
  winner: ModuleIdentity;
  /** True when members disagree on major version (or a version is unparseable). */
  conflict: boolean;
}

/** Pick the winning member of a same-identity group and classify it. The winner
 *  is the highest version (deterministic tiebreak on source URL for equal
 *  versions / same-version-different-source). A major disagreement — or any
 *  unparseable version — marks the group a conflict; we still pick a winner so
 *  the rest of analysis proceeds against a single version instead of cascading
 *  duplicate-kind errors. */
function resolveGroup(members: ModuleIdentity[]): GroupResolution {
  const majors = new Set<number | null>();
  for (const m of members) majors.add(m.parsed ? m.parsed.major : null);
  const conflict = majors.has(null) || majors.size > 1;

  const winner = members.reduce((best, cur) => {
    if (!cur.parsed) return best;
    if (!best.parsed) return cur;
    const cmp = compareParsedModuleVersions(cur.parsed, best.parsed);
    if (cmp > 0) return cur;
    if (cmp === 0 && cur.source < best.source) return cur;
    return best;
  }, members[0]);

  return { winner, conflict };
}

/** The diagnostic for a redirected edge, or `null` when the redirect is a
 *  silent dedupe (the same version resolved from two sources with identical
 *  content — no decision was made, so nothing to report). */
function hoistDiagnostic(
  identity: string,
  importerSource: string,
  alias: string,
  loser: ModuleIdentity,
  winner: ModuleIdentity,
  conflict: boolean,
): AnalysisDiagnostic | null {
  const data = { filePath: importerSource, path: `imports.${alias}` };
  if (conflict) {
    return {
      severity: DiagnosticSeverity.Error,
      code: "MODULE_VERSION_CONFLICT",
      source: SOURCE,
      message:
        `Module '${identity}' is imported at incompatible major versions: ` +
        `${loser.version || "<unknown>"} here and ${winner.version} elsewhere in the same graph. ` +
        `Major versions can carry breaking changes and cannot be reconciled automatically — ` +
        `align every importer on one major.`,
      data,
    };
  }
  if (loser.version === winner.version) {
    // Same version, two sources. Identical content is a no-op dedupe; differing
    // content means one is masquerading as the other (e.g. a local checkout vs
    // the published version) — worth surfacing.
    if (loser.text === winner.text) return null;
    return {
      severity: DiagnosticSeverity.Warning,
      code: "MODULE_VERSION_HOISTED",
      source: SOURCE,
      message:
        `Module '${identity}@${winner.version}' is imported from two sources whose contents ` +
        `differ ('${loser.source}' and '${winner.source}'). Using '${winner.source}' for every ` +
        `importer — pin a single source to remove the ambiguity.`,
      data,
    };
  }
  // Same-major hoist to a higher version: additive pre-1.0, so the redirect is
  // non-lossy and by design — resolve to the winner silently, like a package
  // manager picking the highest compatible version of a transitive dep.
  return null;
}

/**
 * Reconcile a loaded import graph so each module location (an import ref minus
 * its version) resolves to a single version. Within a shared major the highest version wins
 * (a non-lossy hoist, given Telo's additive-only pre-1.0 policy); a major
 * mismatch is a hard conflict. Mutates `importEdges` in place — every edge that
 * pointed at a losing source is repointed at the winner — so `flattenForAnalyzer`
 * walks a deduplicated graph and the runtime collision (two definitions of the
 * same kind) cannot occur. Pure and browser-safe: no I/O, no Node built-ins.
 */
export function reconcileModuleVersions(
  modules: Map<string, LoadedModule>,
  importEdges: Map<string, Map<string, ImportEdge>>,
): VersionReconciliation {
  const overrides = new Map<string, string>();
  const diagnostics: AnalysisDiagnostic[] = [];

  // Location identity per resolved module, taken from the ref that reached it.
  // Two refs at different versions resolve to different canonical sources, so a
  // source normally maps to exactly one identity; the entry module has no
  // inbound edge and needs none (it is never reconciled against itself).
  //
  // One source CAN be reached by two spellings of the same location (a ref and
  // the direct URL it resolves to). Both name the same module
  // at the same version, so either identity groups it correctly — but the choice
  // must not depend on edge iteration order, or the same graph could reconcile
  // differently across runs. First edge wins.
  const identityBySource = new Map<string, string>();
  for (const aliasMap of importEdges.values()) {
    for (const edge of aliasMap.values()) {
      if (identityBySource.has(edge.targetSource)) continue;
      const identity = refIdentity(edge.targetRef);
      if (identity) identityBySource.set(edge.targetSource, identity);
    }
  }

  const groups = new Map<string, ModuleIdentity[]>();
  const infoBySource = new Map<string, ModuleIdentity>();
  for (const [source, mod] of modules) {
    const identity = identityBySource.get(source);
    if (!identity) continue;
    const info = moduleIdentityOf(mod, identity);
    if (!info) continue;
    infoBySource.set(info.source, info);
    const list = groups.get(info.identity);
    if (list) list.push(info);
    else groups.set(info.identity, [info]);
  }

  const conflictByIdentity = new Map<string, boolean>();
  for (const [identity, members] of groups) {
    if (members.length < 2) continue;
    const { winner, conflict } = resolveGroup(members);
    conflictByIdentity.set(identity, conflict);
    for (const member of members) {
      if (member.source !== winner.source) overrides.set(member.source, winner.source);
    }
  }

  if (overrides.size === 0) return { overrides, diagnostics };

  for (const [importerSource, aliasMap] of importEdges) {
    for (const [alias, edge] of aliasMap) {
      const winnerSource = overrides.get(edge.targetSource);
      if (!winnerSource) continue;
      const loser = infoBySource.get(edge.targetSource);
      const winner = infoBySource.get(winnerSource);
      if (loser && winner) {
        const diag = hoistDiagnostic(
          loser.identity,
          importerSource,
          alias,
          loser,
          winner,
          conflictByIdentity.get(loser.identity) ?? false,
        );
        if (diag) diagnostics.push(diag);
      }
      edge.targetSource = winnerSource;
    }
  }

  return { overrides, diagnostics };
}

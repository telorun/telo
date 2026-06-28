import type { ImportEdge, LoadedModule } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
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

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or `null` for a release version. */
  pre: string[] | null;
}

interface ModuleIdentity {
  source: string;
  identity: string;
  version: string;
  parsed: ParsedVersion | null;
  text: string;
}

/** Parse `X.Y.Z`, `vX.Y.Z`, or `X.Y.Z-pre.1`. Returns `null` for anything that
 *  isn't a plain three-part numeric core — an unparseable version forces the
 *  group onto the conflict path (we never silently hoist across a version we
 *  can't reason about). Pure: no dependency on the `semver` package, so the
 *  analyzer stays browser-safe and dependency-free. */
function parseVersion(raw: string | undefined): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const v = raw.startsWith("v") ? raw.slice(1) : raw;
  const [core, ...preParts] = v.split("-");
  const pre = preParts.length > 0 ? preParts.join("-") : null;
  const segments = core.split(".");
  if (segments.length !== 3) return null;
  const [major, minor, patch] = segments.map((s) => {
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
  });
  if ([major, minor, patch].some((n) => Number.isNaN(n))) return null;
  return { major, minor, patch, pre: pre === null ? null : pre.split(".") };
}

/** SemVer precedence: numeric core, then a release outranks a prerelease, then
 *  prerelease identifiers compared field-by-field (numeric < non-numeric per
 *  spec, shorter set loses when all shared fields are equal). */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Read a loaded module's `namespace/name` identity, version, and raw owner
 *  text. Returns `null` for modules without a namespace: only a registry
 *  identity (`<namespace>/<name>`) is a stable cross-import key. Two namespace-
 *  less local libraries that merely share a `metadata.name` are distinct modules
 *  reached via distinct source URLs — reconciling them would drop one and break
 *  its kinds; the same local file reached via two paths is already collapsed by
 *  canonical-source dedup, so there is nothing left to reconcile here. */
function moduleIdentityOf(mod: LoadedModule): ModuleIdentity | null {
  const doc = mod.owner.manifests.find((m) => m && isModuleKind(m.kind));
  if (!doc) return null;
  const meta = doc.metadata as { name?: string; namespace?: string | null; version?: string };
  const name = meta?.name;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof meta.namespace !== "string" || meta.namespace.length === 0) return null;
  const version = typeof meta.version === "string" ? meta.version : "";
  return {
    source: mod.owner.source,
    identity: `${meta.namespace}/${name}`,
    version,
    parsed: parseVersion(version),
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
    const cmp = compareVersions(cur.parsed, best.parsed);
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
 * Reconcile a loaded import graph so each module identity (`namespace/name`)
 * resolves to a single version. Within a shared major the highest version wins
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

  const groups = new Map<string, ModuleIdentity[]>();
  const infoBySource = new Map<string, ModuleIdentity>();
  for (const mod of modules.values()) {
    const info = moduleIdentityOf(mod);
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

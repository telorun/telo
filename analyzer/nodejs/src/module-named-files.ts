/**
 * The rules that relate a module's `native:` entries, its file claims and its
 * `sources:` block — which files a source may stage, which declarations collide
 * on one path, and which staged entries nothing names.
 *
 * One home, because `telo check` (`validate-native-entries.ts`,
 * `validate-source-entries.ts`) and `telo publish` apply the same rules to the
 * same manifest; two copies would each drift toward whatever its own tests pin.
 * Callers read the three blocks with their own readers and hand the results in.
 * Browser-safe: no filesystem.
 */

import { PLATFORM_AXES, describeSelector } from "./artifact-selector.js";
import type { LocatedClaim, ModuleFileClaim } from "./module-file-claims.js";
import type { NativeEntry } from "./native-entries.js";
import type { ModuleSource, SourceEntry } from "./source-entries.js";

const CLAIM_LABEL: Record<ModuleFileClaim["role"], string> = {
  controller: "the controller candidate",
  library: "the exports.code entry",
  assets: "the embed",
};

/** The declaration behind a claim, for messages: `the controller candidate pkg:… on Telo.Definition/Reader`. */
export function describeClaim(located: LocatedClaim): string {
  const { claim, where } = located;
  return `${CLAIM_LABEL[claim.role]} ${claim.origin}${where === undefined ? "" : ` on ${where}`}`;
}

/** A `native:` entry whose path another declaration also names. */
export interface NativeClaimConflict {
  readonly entry: NativeEntry;
  readonly claim: LocatedClaim;
}

/**
 * Every `native:` entry whose path the module also names as code or as an embed.
 * Each declaration decides a different layer, and a file extracts from exactly
 * one — a runtime materializing one would find the file missing through the other.
 */
export function nativeClaimConflicts(
  native: readonly NativeEntry[],
  claims: readonly LocatedClaim[],
): NativeClaimConflict[] {
  const out: NativeClaimConflict[] = [];
  for (const entry of native) {
    for (const claim of claims) {
      if (claim.claim.path === entry.path) out.push({ entry, claim });
    }
  }
  return out;
}

/** A file a `sources:` entry may stage. */
export interface StageableFile {
  readonly path: string;
  /** The declaration naming it, for messages. */
  readonly label: string;
  /** The layer it ships in, for messages. */
  readonly layer: string;
  /** Produced by a controller build (`local_path=`) rather than staged or committed. */
  readonly built: boolean;
}

/**
 * The files the module names that a `sources:` entry may stage: every `native:`
 * entry's path, and every bundled controller candidate's `path=` that carries a
 * platform qualifier. A platform-neutral candidate is one bundle for every host,
 * which nothing stages.
 */
export function stageableFiles(
  native: readonly NativeEntry[],
  claims: readonly LocatedClaim[],
): Map<string, StageableFile> {
  const out = new Map<string, StageableFile>();
  for (const entry of native) {
    if (out.has(entry.path)) continue;
    out.set(entry.path, {
      path: entry.path,
      label: `${entry.origin} for ${describeSelector(entry.selector)}`,
      layer: `native ${describeSelector(entry.selector)}`,
      built: false,
    });
  }
  for (const { claim } of claims) {
    if (claim.role !== "controller") continue;
    if (!PLATFORM_AXES.some((axis) => claim.selector[axis] !== undefined)) continue;
    const existing = out.get(claim.path);
    if (existing) {
      if (claim.localPath && !existing.built) out.set(claim.path, { ...existing, built: true });
      continue;
    }
    out.set(claim.path, {
      path: claim.path,
      label: `controller candidate ${claim.origin}`,
      layer: `controller ${describeSelector(claim.selector)}`,
      built: claim.localPath !== undefined,
    });
  }
  return out;
}

/** A `sources:` entry, with the source declaring it. */
export interface LocatedSourceEntry {
  readonly source: ModuleSource;
  readonly entry: SourceEntry;
}

/**
 * The staged entries nothing in the module names: not a stageable file, and not
 * one of the entry's own source's notices. `alsoNamed` holds paths the caller
 * knows are named though they did not read — a `native:` entry with an unrelated
 * problem — so one defect is not reported twice.
 */
export function unclaimedSourceEntries(
  sources: readonly ModuleSource[],
  stageable: ReadonlyMap<string, StageableFile>,
  alsoNamed: ReadonlySet<string> = new Set(),
): LocatedSourceEntry[] {
  const out: LocatedSourceEntry[] = [];
  for (const source of sources) {
    for (const entry of source.entries) {
      if (stageable.has(entry.path) || source.notices.includes(entry.path)) continue;
      if (alsoNamed.has(entry.path)) continue;
      out.push({ source, entry });
    }
  }
  return out;
}

/** A link whose target ships in a different layer than the link. */
export interface CrossLayerLink {
  readonly source: ModuleSource;
  readonly entry: Extract<SourceEntry, { kind: "link" }>;
  readonly layer: string;
  readonly targetLayer: string;
}

/**
 * The link entries whose target ships in another layer. A runtime extracts only
 * the layers it needs, so such a link dangles wherever the other layer is not
 * materialized. A notice ships in `common`.
 */
export function crossLayerSourceLinks(
  sources: readonly ModuleSource[],
  stageable: ReadonlyMap<string, StageableFile>,
): CrossLayerLink[] {
  const layerOf = (source: ModuleSource, path: string): string | undefined =>
    stageable.get(path)?.layer ?? (source.notices.includes(path) ? "common" : undefined);
  const out: CrossLayerLink[] = [];
  for (const source of sources) {
    for (const entry of source.entries) {
      if (entry.kind !== "link") continue;
      const layer = layerOf(source, entry.path);
      const targetLayer = layerOf(source, entry.resolved);
      if (layer !== undefined && targetLayer !== undefined && layer !== targetLayer) {
        out.push({ source, entry, layer, targetLayer });
      }
    }
  }
  return out;
}

import {
  buildLineOffsets,
  isLocalPathSource,
  isNewerModuleVersion,
  newestModuleVersion,
  parseToAst,
  parseVersionedRef,
  withRefVersion,
  type AstDocument,
  type Range,
} from "@telorun/analyzer";
import { findImportEntries, type ImportEntry } from "./find-import-entries.js";

/** Version enumeration for one version-independent base ref, newest first.
 *
 *  Narrower than the full `IdeEnvironmentAdapter` on purpose. It is the only
 *  environment capability an upgrade check needs, and a host that caches or
 *  throttles hub traffic wraps just this — a CodeLens re-resolves far more
 *  often than a completion popup opens, so the refresh cadence is the host's
 *  policy, not this module's. A host backed by the hub passes
 *  `adapter.listVersionsForRef`. */
export type ModuleVersionLookup = (baseRef: string) => Promise<string[]>;

/** A source edit a host applies verbatim to upgrade an import. Ranges never
 *  overlap, within an upgrade or across a batch, so a host may apply the whole
 *  set in one pass without ordering them. */
export interface ImportUpgradeEdit {
  range: Range;
  newText: string;
}

/** One import that has a newer version available. */
export interface ImportUpgrade {
  alias: string;
  /** The source as written, with any object-form `integrity:` folded in. */
  source: string;
  currentVersion: string;
  latestVersion: string;
  /** The source that replaces it: re-pointed at `latestVersion` with the
   *  integrity pin dropped. */
  newSource: string;
  /** True when the replaced import carried a pin. A host that cannot recompute
   *  the hash should say so — the pin covers the version being replaced, and
   *  `telo upgrade` re-pins either shape. */
  wasPinned: boolean;
  /** Span of the alias key — where a per-entry affordance anchors. */
  keyRange: Range;
  /** Apply all of these to upgrade this one import. */
  edits: ImportUpgradeEdit[];
}

/** An import that IS behind but that this module declines to rewrite. Carries
 *  the same anchor and versions an {@link ImportUpgrade} does, so a host can
 *  render it in place of the upgrade affordance rather than leaving the author
 *  wondering why a stale import shows nothing at all. */
export interface ImportUpgradeSkip {
  alias: string;
  currentVersion: string;
  latestVersion: string;
  /** Span of the alias key — where a per-entry affordance anchors. */
  keyRange: Range;
  /** Author-facing sentence: what was not done, and what to run instead. */
  reason: string;
}

export interface ImportUpgradeSet {
  /** Span of the `imports:` key — where a summary affordance anchors. */
  importsKeyRange: Range;
  upgrades: ImportUpgrade[];
  skipped: ImportUpgradeSkip[];
  /** Base refs whose version lookup failed. Never thrown: one unreachable ref
   *  must not blank the affordances for every other import in the file. The
   *  host decides whether to log or surface these. */
  failures: Array<{ baseRef: string; message: string }>;
}

/**
 * Find every `imports:` entry of a module document that names a version older
 * than the newest one `listVersions` reports, and produce the source edits that
 * re-point it.
 *
 * Skips what carries no upgradeable version: local path imports, bare URLs,
 * untagged refs, and pins that are not SemVer (an OCI digest, a moving tag like
 * `latest`) — `parseVersionedRef` and `isNewerModuleVersion` both decline to
 * guess, so those simply produce no upgrade.
 *
 * Pure apart from `listVersions`: no filesystem, no direct network, no host
 * API. Returns `undefined` when the file declares no module document or the
 * module declares no `imports:`.
 */
export async function buildImportUpgrades(
  text: string,
  listVersions: ModuleVersionLookup,
  docs?: AstDocument[],
): Promise<ImportUpgradeSet | undefined> {
  const lineOffsets = buildLineOffsets(text);
  const block = findImportEntries(text, docs ?? parseToAst(text), lineOffsets);
  if (!block) return undefined;

  const candidates = block.entries.flatMap((entry) => {
    if (isLocalPathSource(entry.source)) return [];
    const ref = parseVersionedRef(entry.source);
    return ref ? [{ entry, ref }] : [];
  });

  const failures: Array<{ baseRef: string; message: string }> = [];
  const latest = await resolveLatest(
    [...new Set(candidates.map((c) => c.ref.baseRef))],
    listVersions,
    failures,
  );

  const upgrades: ImportUpgrade[] = [];
  const skipped: ImportUpgradeSkip[] = [];

  for (const { entry, ref } of candidates) {
    const newest = latest.get(ref.baseRef);
    if (!newest || !isNewerModuleVersion(newest, ref.version)) continue;

    if (entry.integrityInline) {
      skipped.push({
        alias: entry.alias,
        currentVersion: ref.version,
        latestVersion: newest,
        keyRange: entry.keyRange,
        reason:
          `'${entry.alias}' carries an inline 'integrity:' that shares a line with other ` +
          `fields, so the stale pin cannot be removed by a line edit. Run \`telo upgrade\`.`,
      });
      continue;
    }

    upgrades.push({
      alias: entry.alias,
      source: entry.source,
      currentVersion: ref.version,
      latestVersion: newest,
      newSource: withRefVersion(entry.source, newest),
      wasPinned: ref.integrity != null,
      keyRange: entry.keyRange,
      edits: buildEdits(entry, withRefVersion(entry.source, newest)),
    });
  }

  return { importsKeyRange: block.keyRange, upgrades, skipped, failures };
}

/** Re-point the source scalar, and delete a now-stale object-form `integrity:`
 *  line. `withRefVersion` already strips an inline `#sha256-…` fragment, so the
 *  scalar shorthand needs no second edit. Dropping the pin is not optional: it
 *  hashes the `telo.yaml` of the version being replaced, so carrying it onto a
 *  different version turns the next install into a tamper error. */
function buildEdits(entry: ImportEntry, newSource: string): ImportUpgradeEdit[] {
  const edits: ImportUpgradeEdit[] = [{ range: entry.sourceRange, newText: newSource }];
  if (entry.integrityLineRange) {
    edits.push({ range: entry.integrityLineRange, newText: "" });
  }
  return edits;
}

/** Newest version per base ref, fetched once each. A ref whose lookup rejects
 *  is recorded in `failures` and left out of the map, so it yields no upgrade
 *  rather than a wrong one. */
async function resolveLatest(
  baseRefs: string[],
  listVersions: ModuleVersionLookup,
  failures: Array<{ baseRef: string; message: string }>,
): Promise<Map<string, string>> {
  const results = await Promise.all(
    baseRefs.map(async (baseRef) => {
      try {
        const versions = await listVersions(baseRef);
        return { baseRef, newest: newestModuleVersion(versions) };
      } catch (err) {
        failures.push({
          baseRef,
          message: err instanceof Error ? err.message : String(err),
        });
        return { baseRef, newest: undefined };
      }
    }),
  );

  const map = new Map<string, string>();
  for (const { baseRef, newest } of results) {
    if (newest) map.set(baseRef, newest);
  }
  return map;
}


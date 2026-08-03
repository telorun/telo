import {
  buildLineOffsets,
  foldIntegrity,
  isCanonicalIntegrity,
  isLocalPathSource,
  isNewerModuleVersion,
  isSameModuleVersion,
  newestModuleVersion,
  parseModuleVersion,
  parseToAst,
  parseVersionedRef,
  withRefVersion,
  type AstDocument,
  type Range,
} from "@telorun/analyzer";
import { findImportEntries, type ImportEntry } from "./find-import-entries.js";

/** One version of a module, as the hub reports it.
 *
 *  `integrity` is the import pin for exactly this version (`sha256-<base64url>`
 *  over whatever the owning transport verifies its own reads against). It is
 *  absent for a version the hub tracked before it recorded pins, and for a ref
 *  no transport can hash — never an error, just no pin to write. */
export interface ModuleVersion {
  version: string;
  integrity?: string;
}

/** Version enumeration for one version-independent base ref, newest first.
 *
 *  Narrower than the full `IdeEnvironmentAdapter` on purpose. It is the only
 *  environment capability an upgrade check needs, and a host that caches or
 *  throttles hub traffic wraps just this — a CodeLens re-resolves far more
 *  often than a completion popup opens, so the refresh cadence is the host's
 *  policy, not this module's.
 *
 *  Deliberately NOT `adapter.listVersionsForRef`, which answers `string[]`:
 *  completion offers names, an upgrade writes a pin, so the two want different
 *  things from one route. A host backed by the hub fetches
 *  `GET /module/versions` and passes the body through
 *  {@link parseModuleVersions}. */
export type ModuleVersionLookup = (baseRef: string) => Promise<ModuleVersion[]>;

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
  /** What the import resolves to after the edits, in the same folded form as
   *  `source` — re-pointed at `latestVersion`, carrying the new pin as a
   *  `#sha256-…` fragment when one was available. Folded rather than literal
   *  because where the pin physically lands depends on the shape the author
   *  wrote (fragment vs `integrity:` sibling), and a host showing this as a
   *  preview wants the resolved import, not one of two spellings of it. */
  newSource: string;
  /** True when the replaced import carried a pin. */
  wasPinned: boolean;
  /** True when the edits leave the import pinned to `latestVersion`. False
   *  means no pin was available for the target version — a host should say so
   *  when `wasPinned`, since the rewrite silently drops a hash the author had. */
  repinned: boolean;
  /** Span of the alias key — where a per-entry affordance anchors. */
  keyRange: Range;
  /** Apply all of these to upgrade this one import. */
  edits: ImportUpgradeEdit[];
}

/** One import that is already at the newest version but carries no integrity
 *  pin, and for which a pin is available. Mirrors what `telo upgrade` does with
 *  `ensurePinned`: a rarely-released module whose version never moves would
 *  otherwise stay unpinned forever, because nothing ever offers to rewrite it. */
export interface ImportPin {
  alias: string;
  source: string;
  version: string;
  /** The source that replaces it: unchanged but for the appended pin. */
  newSource: string;
  /** Span of the alias key — where a per-entry affordance anchors. */
  keyRange: Range;
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
  pins: ImportPin[];
  skipped: ImportUpgradeSkip[];
  /** Base refs whose version lookup failed. Never thrown: one unreachable ref
   *  must not blank the affordances for every other import in the file. The
   *  host decides whether to log or surface these. */
  failures: Array<{ baseRef: string; message: string }>;
}

/**
 * Find every `imports:` entry of a module document that names a version older
 * than the newest one `listVersions` reports, and produce the source edits that
 * re-point it — plus every entry already at the newest version that carries no
 * integrity pin, and the edits that pin it.
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
  const known = await resolveVersions(
    [...new Set(candidates.map((c) => c.ref.baseRef))],
    listVersions,
    failures,
  );

  const upgrades: ImportUpgrade[] = [];
  const pins: ImportPin[] = [];
  const skipped: ImportUpgradeSkip[] = [];

  for (const { entry, ref } of candidates) {
    const versions = known.get(ref.baseRef);
    if (!versions) continue;
    const newest = newestModuleVersion(versions.map((v) => v.version));
    if (!newest) continue;

    if (!isNewerModuleVersion(newest, ref.version)) {
      const pin = pinInPlace(entry, ref.version, ref.integrity, versions);
      if (pin) pins.push(pin);
      continue;
    }

    const integrity = integrityFor(versions, newest);
    // A stale pin that can be neither replaced nor removed is the one case left
    // that has to be declined: re-pointing the source while leaving a hash for
    // the version it replaced turns the next install into a tamper error.
    if (ref.integrity && !integrity && entry.integrity && !entry.integrity.lineRange) {
      skipped.push({
        alias: entry.alias,
        currentVersion: ref.version,
        latestVersion: newest,
        keyRange: entry.keyRange,
        reason:
          `'${entry.alias}' carries an inline 'integrity:' that shares a line with other ` +
          `fields, and no pin is published for ${newest}, so the stale one cannot be ` +
          `removed by a line edit. Run \`telo upgrade\`.`,
      });
      continue;
    }

    const newSource = withRefVersion(entry.source, newest);
    upgrades.push({
      alias: entry.alias,
      source: entry.source,
      currentVersion: ref.version,
      latestVersion: newest,
      newSource: foldIntegrity(newSource, integrity),
      wasPinned: ref.integrity != null,
      repinned: integrity != null,
      keyRange: entry.keyRange,
      edits: buildEdits(entry, newSource, integrity),
    });
  }

  return { importsKeyRange: block.keyRange, upgrades, pins, skipped, failures };
}

/** The edits that re-point an entry at `newSource` and settle its pin.
 *
 *  Where the pin is written follows the shape the author chose: an entry with an
 *  `integrity:` sibling keeps it (its value is replaced in place, which works in
 *  block and flow style alike), and everything else carries the pin inside the
 *  source as a `#sha256-…` fragment — the form `telo upgrade` writes.
 *
 *  With no pin available the sibling is deleted instead. That is not optional:
 *  it hashes the `telo.yaml` of the version being replaced, so carrying it onto
 *  a different version turns the next install into a tamper error.
 *  `withRefVersion` has already stripped a fragment-form pin for the same
 *  reason, so the scalar shorthand needs no second edit. */
function buildEdits(
  entry: ImportEntry,
  newSource: string,
  integrity: string | undefined,
): ImportUpgradeEdit[] {
  if (!entry.integrity) {
    return [{ range: entry.sourceRange, newText: foldIntegrity(newSource, integrity) }];
  }

  const edits: ImportUpgradeEdit[] = [{ range: entry.sourceRange, newText: newSource }];
  if (integrity) {
    edits.push({ range: entry.integrity.valueRange, newText: integrity });
  } else if (entry.integrity.lineRange) {
    edits.push({ range: entry.integrity.lineRange, newText: "" });
  }
  return edits;
}

/** Pin an entry that is already at the newest version, or `undefined` when
 *  there is nothing to do — it is pinned already, the hub published no pin for
 *  the version it names, or that version is not one this module will order.
 *
 *  The version gate matters: a moving tag (`latest`) or a digest names bytes
 *  that are expected to change, so pinning it would break the next release
 *  rather than protect it. `telo upgrade` draws the same line. */
function pinInPlace(
  entry: ImportEntry,
  version: string,
  existingIntegrity: string | undefined,
  versions: ModuleVersion[],
): ImportPin | undefined {
  if (existingIntegrity != null || entry.integrity) return undefined;
  if (parseModuleVersion(version) === null) return undefined;
  const integrity = integrityFor(versions, version);
  if (!integrity) return undefined;

  const newSource = foldIntegrity(entry.source, integrity);
  return {
    alias: entry.alias,
    source: entry.source,
    version,
    newSource,
    keyRange: entry.keyRange,
    edits: [{ range: entry.sourceRange, newText: newSource }],
  };
}

/** The pin the hub reports for one version, matched by SemVer identity rather
 *  than string equality so a `v`-prefixed tag on either side still lines up.
 *
 *  Re-checked here even though the host's parse already did: this value is
 *  spliced into the author's YAML, and a caller reaching the builder through
 *  its own `ModuleVersionLookup` never passed through that parse. */
function integrityFor(versions: ModuleVersion[], version: string): string | undefined {
  const integrity = versions.find((v) => isSameModuleVersion(v.version, version))?.integrity;
  return isCanonicalIntegrity(integrity) ? integrity : undefined;
}

/** Versions per base ref, fetched once each. A ref whose lookup rejects is
 *  recorded in `failures` and left out of the map, so it yields no upgrade
 *  rather than a wrong one. */
async function resolveVersions(
  baseRefs: string[],
  listVersions: ModuleVersionLookup,
  failures: Array<{ baseRef: string; message: string }>,
): Promise<Map<string, ModuleVersion[]>> {
  const results = await Promise.all(
    baseRefs.map(async (baseRef) => {
      try {
        return { baseRef, versions: await listVersions(baseRef) };
      } catch (err) {
        failures.push({
          baseRef,
          message: err instanceof Error ? err.message : String(err),
        });
        return { baseRef, versions: undefined };
      }
    }),
  );

  const map = new Map<string, ModuleVersion[]>();
  for (const { baseRef, versions } of results) {
    if (versions) map.set(baseRef, versions);
  }
  return map;
}

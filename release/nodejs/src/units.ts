/**
 * From `release.units` to the units of one tree.
 *
 * A unit is a directory with one version, one changelog and one fragment
 * target, however many packages it ships. Its entry is the LAST one matching
 * its path (a `!` entry excludes); each of its anchors is a literal directory
 * inside it that the anchor's ecosystem recognises as exactly one package. A
 * pattern entry skips a directory whose anchors are not all recognised; a
 * literal one refuses it. Recognition, version locations and layers are each
 * adapter's answer — this file names no ecosystem.
 */

import { lastMatchIndex, selectByPatterns } from "@telorun/glob";
import type { AdapterRegistry, RecognizedPackage, VersionLocationSpec } from "./adapter.js";
import type { BumpLevel } from "./bump-level.js";
import { normalizeUnitKey, type UnitKey } from "./fragment.js";
import type { WorkspaceDiagnostic } from "./marker-reader.js";
import { DEFAULT_RELEASE_IGNORE } from "./marker-schema.js";
import type { PayloadSpec, ReleaseSettings, UnitEntry } from "./release-settings.js";
import { VersionFileError, readVersionAt, writeVersionAt } from "./version-files.js";

/** What a host lets the resolver see of the tree, every path workspace-relative
 *  and `/`-separated. */
export interface WorkspaceTree {
  /** Every directory, pruned as the host prunes (`node_modules`, `.git`). */
  directories(): readonly string[];
  /** Every file beneath `dir`, relative to it. */
  filesUnder(dir: string): readonly string[];
  /** A file's text, or `undefined` when absent. */
  readFile(path: string): string | undefined;
}

export interface ResolvedAnchor {
  readonly ecosystem: string;
  /** Unit-relative (`.` the unit itself). */
  readonly anchor: string;
  /** Workspace-relative directory (`""` the workspace root). */
  readonly dir: string;
  readonly package: RecognizedPackage;
  /** The anchor's settings: its own, over `release.ecosystems.<ecosystem>`'s,
   *  each key replacing whole. */
  readonly settings: Readonly<Record<string, unknown>>;
}

/** A workspace-relative file carrying a unit's version, and where in it. */
export interface VersionLocation {
  readonly file: string;
  readonly pointer?: string;
}

export interface ResolvedUnit {
  readonly key: UnitKey;
  /** Workspace-relative directory (`""` the workspace root). */
  readonly dir: string;
  /** The `release.units` entry that decided it. */
  readonly entry: UnitEntry;
  readonly anchors: readonly ResolvedAnchor[];
  /** Where the unit's version is read from. */
  readonly version: VersionLocation;
  /** Every location `apply` writes the version to, `version` first. */
  readonly versionLocations: readonly VersionLocation[];
  readonly payload?: PayloadSpec;
  readonly metafile?: string;
  readonly ignore: readonly string[];
  readonly maxBump: BumpLevel;
  readonly group?: string;
}

export interface UnitResolution {
  readonly units: readonly ResolvedUnit[];
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}

const PATTERN = /[*?]/;

export function joinPath(dir: string, relative: string): string {
  if (relative === "." || relative === "") return dir;
  return dir === "" ? relative : `${dir}/${relative}`;
}

function unitDir(key: UnitKey): string {
  return key === "." ? "" : key;
}

/**
 * The entry deciding `key`, or `undefined` when none matches or the last match
 * excludes it. A literal path matches its own directory only; a pattern matches
 * gitignore-style.
 */
export function decidingEntry(release: ReleaseSettings, key: UnitKey): UnitEntry | undefined {
  let decided: UnitEntry | undefined;
  for (const entry of release.units) {
    const negated = entry.path.startsWith("!");
    const path = negated ? entry.path.slice(1) : entry.path;
    const matches = PATTERN.test(path)
      ? lastMatchIndex(key, [path]) >= 0
      : normalizeUnitKey(path) === key;
    if (matches) decided = negated ? undefined : entry;
  }
  return decided;
}

export function resolveUnits(
  release: ReleaseSettings,
  tree: WorkspaceTree,
  adapters: AdapterRegistry,
): UnitResolution {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const report = (message: string, code: WorkspaceDiagnostic["code"], path: (string | number)[]) =>
    diagnostics.push({ code, severity: "error", message, path });

  const candidates = new Set(tree.directories().map(normalizeUnitKey));
  for (const entry of release.units) {
    if (!entry.path.startsWith("!") && !PATTERN.test(entry.path)) {
      candidates.add(normalizeUnitKey(entry.path) || ".");
    }
  }

  const groupOf = new Map<UnitKey, string>();
  for (const [name, members] of release.groups) for (const member of members) groupOf.set(member, name);

  const directories = new Set(tree.directories().map(normalizeUnitKey));
  const units: ResolvedUnit[] = [];
  const claims = new Map<string, UnitKey>();
  for (const key of [...candidates].sort()) {
    const entry = decidingEntry(release, key);
    if (!entry) continue;
    const literal = !PATTERN.test(entry.path);
    const at: (string | number)[] = ["release", "units", entry.index];
    const dir = unitDir(key);

    const anchors: ResolvedAnchor[] = [];
    let skipped = false;
    let unavailable = false;
    for (const ecosystem of [...(entry.ecosystem?.keys() ?? [])].sort()) {
      const adapter = adapters.get(ecosystem);
      if (!adapter) {
        unavailable = true;
        continue;
      }
      for (const anchor of entry.ecosystem!.get(ecosystem)!) {
        const anchorDir = joinPath(dir, anchor);
        const recognized = adapter.recognize({
          unit: key,
          anchor,
          dir: anchorDir,
          readFile: (relative) => tree.readFile(joinPath(anchorDir, relative)),
        });
        if (recognized) {
          const settings = {
            ...(release.ecosystems.get(ecosystem) ?? {}),
            ...(entry.anchorSettings.get(ecosystem)?.get(anchor) ?? {}),
          };
          // A directory setting must name one; the reader has refused a pattern
          // and a path leaving the workspace.
          let missing = false;
          for (const [name, schema] of Object.entries(adapter.keys ?? {})) {
            const value = settings[name];
            if (schema.type !== "directory" || typeof value !== "string" || value === ".") continue;
            if (directories.has(value)) continue;
            missing = true;
            report(
              `${ecosystem} anchor '${anchorDir || "."}' of unit '${key}' names ${name} '${value}', ` +
                `which is not a directory of this workspace.`,
              "WORKSPACE_ANCHOR_INVALID",
              [...at, "ecosystem"],
            );
          }
          if (missing) {
            skipped = true;
            continue;
          }
          anchors.push({ ecosystem, anchor, dir: anchorDir, package: recognized, settings });
          continue;
        }
        skipped = true;
        if (literal) {
          report(
            `'${anchorDir || "."}' is anchored as ${ecosystem} by unit '${key}', but it is not ` +
              `${adapter.anchorDescription}.`,
            "WORKSPACE_ANCHOR_INVALID",
            [...at, "ecosystem"],
          );
        }
      }
    }
    // An unavailable ecosystem is reported where the entry is read.
    if (skipped || unavailable) continue;

    const version = primaryVersion(entry, dir, anchors, adapters);
    // Zero or several defaulting anchors is reported where the entry is read.
    if (!version) continue;

    const layers = anchors.filter((anchor) => anchor.package.contributesLayer).length + (entry.payload ? 1 : 0);
    if (layers === 0) {
      report(
        `Unit '${key}' ships no layer: ${
          anchors.length === 0
            ? "it lists no ecosystem"
            : `its packages (${anchors.map((a) => `${a.ecosystem} at ${a.anchor}`).join(", ")}) publish nothing`
        }. List the ecosystem it ships through, declare 'payload:', or exclude it with '!${key}'.`,
        "WORKSPACE_UNIT_PAYLOAD_EMPTY",
        at,
      );
      continue;
    }

    for (const anchor of anchors) {
      const claim = `${anchor.ecosystem}\0${anchor.dir}`;
      const owner = claims.get(claim);
      if (owner !== undefined) {
        report(
          `The ${anchor.ecosystem} package at '${anchor.dir || "."}' is claimed by units '${owner}' ` +
            `and '${key}'. A package belongs to one unit; anchor it in only one of them.`,
          "WORKSPACE_ANCHOR_CLAIMED",
          [...at, "ecosystem"],
        );
        continue;
      }
      claims.set(claim, key);
    }

    const group = groupOf.get(key);
    units.push({
      key,
      dir,
      entry,
      anchors,
      version,
      versionLocations: versionLocations(entry, dir, version, anchors, tree, adapters),
      ...(entry.payload ? { payload: entry.payload } : {}),
      ...(entry.metafile ? { metafile: joinPath(dir, entry.metafile) } : {}),
      ignore: entry.ignore ?? release.ignore ?? DEFAULT_RELEASE_IGNORE,
      maxBump: entry.maxBump ?? release.maxBump ?? "major",
      ...(group !== undefined ? { group } : {}),
    });
  }

  const resolved = new Set(units.map((unit) => unit.key));
  for (const [name, members] of release.groups) {
    for (const [index, member] of members.entries()) {
      if (resolved.has(member)) continue;
      report(
        `Group '${name}' names '${member}', which is not a unit of this workspace.`,
        "WORKSPACE_INVALID_VALUE",
        ["release", "groups", name, index],
      );
    }
  }
  return { units, diagnostics };
}

function primaryVersion(
  entry: UnitEntry,
  dir: string,
  anchors: readonly ResolvedAnchor[],
  adapters: AdapterRegistry,
): VersionLocation | undefined {
  if (entry.version) return located(dir, entry.version);
  const defaulting = anchors.flatMap((anchor) => {
    const spec = adapters.get(anchor.ecosystem)!.versionFile;
    return spec ? [located(anchor.dir, spec)] : [];
  });
  return defaulting.length === 1 ? defaulting[0] : undefined;
}

function located(dir: string, spec: VersionLocationSpec): VersionLocation {
  return { file: joinPath(dir, spec.file), ...(spec.pointer !== undefined ? { pointer: spec.pointer } : {}) };
}

function versionLocations(
  entry: UnitEntry,
  dir: string,
  primary: VersionLocation,
  anchors: readonly ResolvedAnchor[],
  tree: WorkspaceTree,
  adapters: AdapterRegistry,
): VersionLocation[] {
  const found: VersionLocation[] = [primary];
  const add = (location: VersionLocation) => {
    if (!found.some((l) => l.file === location.file && l.pointer === location.pointer)) found.push(location);
  };
  for (const anchor of anchors) {
    const spec = adapters.get(anchor.ecosystem)!.versionFile;
    if (spec) add(located(anchor.dir, spec));
    for (const file of anchor.package.versionFiles ?? []) add({ file: joinPath(anchor.dir, file) });
  }
  const patterns = (entry.versionFiles ?? []).flatMap((spec) => ("pattern" in spec ? [spec.pattern] : []));
  if (patterns.length > 0) {
    const files = selectByPatterns([...tree.filesUnder(dir)], patterns, { applyDefaultIgnore: false });
    for (const file of files) add({ file: joinPath(dir, file) });
  }
  for (const spec of entry.versionFiles ?? []) {
    if ("path" in spec) add({ file: joinPath(dir, spec.path), pointer: spec.pointer });
  }
  return found;
}

/** One version location as read. `value` is absent where the location holds no
 *  version; `error` names why it could not be read. */
export interface VersionReading {
  readonly file: string;
  readonly pointer?: string;
  readonly value?: string;
  readonly error?: string;
}

function describeLocation(location: VersionLocation): string {
  return location.pointer ? `${location.file}#${location.pointer}` : location.file;
}

/** Read every version location of a unit. */
export function readUnitVersions(
  unit: ResolvedUnit,
  readFile: (path: string) => string | undefined,
  adapters: AdapterRegistry,
): VersionReading[] {
  return unit.versionLocations.map((location) => {
    const text = readFile(location.file);
    if (text === undefined) return { ...location, error: `${location.file} does not exist` };
    try {
      const value = readVersionAt(location, text, describeLocation(location), adapters);
      return value === undefined ? { ...location } : { ...location, value };
    } catch (err) {
      return { ...location, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * The files of a unit rewritten to carry `version`, each location in turn (two
 * locations in one file are both applied). Throws on a location that holds no
 * version: leaving it behind ships files that disagree about what they are.
 */
export function stampUnitVersion(
  unit: ResolvedUnit,
  version: string,
  readFile: (path: string) => string | undefined,
  adapters: AdapterRegistry,
): { readonly file: string; readonly text: string }[] {
  const texts = new Map<string, string>();
  for (const location of unit.versionLocations) {
    const before = texts.get(location.file) ?? readFile(location.file);
    if (before === undefined) {
      throw new VersionFileError(`${describeLocation(location)} does not exist, so '${unit.key}' cannot be versioned.`);
    }
    texts.set(location.file, writeVersionAt(location, before, version, describeLocation(location), adapters));
  }
  return [...texts].flatMap(([file, text]) => (text === readFile(file) ? [] : [{ file, text }]));
}

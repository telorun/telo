/**
 * The `release:` block — the units, the groups sharing a version, the ignore
 * list and the highest bump allowed — read against the core schema plus the
 * keys each registered adapter's ecosystem reads on an entry.
 *
 * What is decidable from the text alone is reported here, so an editor shows it
 * as the author types: an ecosystem no adapter serves, an anchor that is not a
 * literal directory inside the unit, a unit whose version cannot be resolved,
 * a key none of the entry's ecosystems reads. What needs the tree — whether an
 * anchor holds a package, whether a unit is left with no layer, two units
 * claiming one package — is `resolveUnits`'.
 */

import { AdapterRegistry, RESERVED_ECOSYSTEMS, type EcosystemAdapter, type VersionLocationSpec } from "./adapter.js";
import { isBumpLevel, type BumpLevel } from "./bump-level.js";
import { normalizeUnitKey, type UnitKey } from "./fragment.js";
import {
  WORKSPACE_FILENAME,
  WorkspaceConfigError,
  parseMarker,
  readKnownKeys,
  readString,
  readStringList,
  reportNullKeys,
  reportUnknownKeys,
  nearMiss,
  type MarkerReport,
  type WorkspaceDiagnostic,
} from "./marker-reader.js";
import { RELEASE_BLOCK_KEYS, UNIT_ENTRY_KEYS } from "./marker-schema.js";

/** A declared payload: unit-relative patterns, or a command printing paths. */
export type PayloadSpec =
  | { readonly patterns: readonly string[] }
  | { readonly command: string };

/** A `versionFiles` entry: a unit-relative pattern, or one file and a pointer. */
export type VersionFileSpec =
  | { readonly pattern: string }
  | { readonly path: string; readonly pointer: string };

export interface UnitEntry {
  /** Index into `release.units`, for anchoring a diagnostic. */
  readonly index: number;
  readonly path: string;
  /** Ecosystem → its anchors, unit-relative and normalized (`.` the unit). */
  readonly ecosystem?: ReadonlyMap<string, readonly string[]>;
  readonly version?: VersionLocationSpec;
  readonly payload?: PayloadSpec;
  readonly metafile?: string;
  readonly versionFiles?: readonly VersionFileSpec[];
  readonly ignore?: readonly string[];
  readonly maxBump?: BumpLevel;
  /** Ecosystem → anchor → the settings written at that anchor, read against the
   *  ecosystem's own keys. An anchor written without settings has none here. */
  readonly anchorSettings: ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, unknown>>>>;
}

export interface ReleaseSettings {
  readonly units: readonly UnitEntry[];
  /** `release.ecosystems`: per ecosystem, the settings every anchor takes unless
   *  its own name the key. */
  readonly ecosystems: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly groups: ReadonlyMap<string, readonly UnitKey[]>;
  readonly ignore?: readonly string[];
  readonly maxBump?: BumpLevel;
}

export interface ReadReleaseOptions {
  /** Per ecosystem no adapter here serves, the host that does — named in
   *  `WORKSPACE_ECOSYSTEM_UNAVAILABLE`. */
  readonly ecosystemHosts?: Readonly<Record<string, string>>;
}

/** Keys of the module list the release block held before units, each refused
 *  naming where it went. */
const MOVED_RELEASE_KEYS: Readonly<Record<string, string>> = {
  modules:
    "'release.modules' became 'release.units': list each unit with the ecosystem it ships " +
    "through, e.g. { path: modules/*, ecosystem: telo }.",
  registry:
    "'release.registry' moved under 'release.ecosystems', keyed by the ecosystem reading it, " +
    "e.g. ecosystems: { telo: { registry: oci://ghcr.io/acme } }.",
};

export function readReleaseBlock(
  raw: unknown,
  where: string,
  report: MarkerReport,
  adapters: AdapterRegistry,
  options: ReadReleaseOptions = {},
): ReleaseSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: 'release' must be a mapping.`, ["release"]);
    return undefined;
  }
  const block = raw as Record<string, unknown>;
  const at = ["release"];
  for (const key of Object.keys(block)) {
    if (key in RELEASE_BLOCK_KEYS) continue;
    if (key in MOVED_RELEASE_KEYS) {
      report("WORKSPACE_MODULES_MOVED", `${where}: ${MOVED_RELEASE_KEYS[key]}`, [...at, key]);
      continue;
    }
    reportUnknownKeys({ [key]: block[key] }, Object.keys(RELEASE_BLOCK_KEYS), where, at, report);
  }

  const ignore = readStringList(block.ignore, where, [...at, "ignore"], report);
  const maxBump = readBumpLevel(block.maxBump, where, [...at, "maxBump"], report);
  const groups = readGroups(block.groups, where, [...at, "groups"], report);
  const ecosystems = readEcosystemDefaults(block.ecosystems, where, [...at, "ecosystems"], report, adapters, options);
  const units = readUnits(block.units, where, [...at, "units"], report, adapters, options);
  return {
    units,
    ecosystems,
    groups,
    ...(ignore !== undefined ? { ignore } : {}),
    ...(maxBump !== undefined ? { maxBump } : {}),
  };
}

function readUnits(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
  options: ReadReleaseOptions,
): UnitEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: 'release.units' must be a list, each entry a path or a mapping carrying 'path:'.`,
      at,
    );
    return [];
  }
  if (raw.length === 0) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: 'release.units' is empty, so nothing is released. List the units, e.g. ` +
        `[{ path: packages/*, ecosystem: npm }].`,
      at,
    );
  }
  const entries: UnitEntry[] = [];
  const schema = RELEASE_BLOCK_KEYS.units!.entry!;
  for (const [index, item] of raw.entries()) {
    const itemAt = [...at, index];
    if (typeof item === "string") {
      if (item === "") {
        report("WORKSPACE_INVALID_VALUE", `${where}: '${itemAt.join(".")}' is empty.`, itemAt);
        continue;
      }
      const entry: UnitEntry = { index, path: item, anchorSettings: new Map() };
      checkResolvable(entry, where, itemAt, report, adapters);
      entries.push(entry);
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: 'release.units' entry ${index} must be a path, or a mapping carrying 'path:' ` +
          `plus the keys it adds.`,
        itemAt,
      );
      continue;
    }
    const fields = item as Record<string, unknown>;
    reportNullKeys(fields, schema, where, itemAt, report);
    const path = readString(fields.path, where, [...itemAt, "path"], report);
    if (path === undefined) {
      if (!Object.hasOwn(fields, "path")) {
        report(
          "WORKSPACE_INVALID_VALUE",
          `${where}: 'release.units' entry ${index} declares no 'path:', so it names nothing.`,
          itemAt,
        );
      }
      continue;
    }

    const read = readEcosystem(fields.ecosystem, where, [...itemAt, "ecosystem"], report, adapters, options);
    const ecosystem = read?.anchors;
    reportEntryKeys(fields, ecosystem ? [...ecosystem.keys()] : [], where, itemAt, report, adapters);

    const version = readVersionLocation(fields.version, where, [...itemAt, "version"], report);
    const payload = readPayload(fields.payload, where, [...itemAt, "payload"], report);
    const metafile = readRelativeFile(fields.metafile, where, [...itemAt, "metafile"], report);
    const versionFiles = readVersionFiles(fields.versionFiles, where, [...itemAt, "versionFiles"], report);
    const ignore = readStringList(fields.ignore, where, [...itemAt, "ignore"], report);
    const maxBump = readBumpLevel(fields.maxBump, where, [...itemAt, "maxBump"], report);
    const entry: UnitEntry = {
      index,
      path,
      ...(ecosystem ? { ecosystem } : {}),
      ...(version ? { version } : {}),
      ...(payload ? { payload } : {}),
      ...(metafile ? { metafile } : {}),
      ...(versionFiles ? { versionFiles } : {}),
      ...(ignore ? { ignore } : {}),
      ...(maxBump ? { maxBump } : {}),
      anchorSettings: read?.settings ?? new Map(),
    };
    checkResolvable(entry, where, itemAt, report, adapters);
    entries.push(entry);
  }
  return entries;
}

/**
 * A key the core does not read. An ecosystem's own key is never flat on an
 * entry: it is named with where it goes instead — the anchor's settings, or the
 * block's defaults for that ecosystem.
 */
function reportEntryKeys(
  fields: Record<string, unknown>,
  listed: readonly string[],
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
): void {
  for (const key of Object.keys(fields)) {
    if (key in UNIT_ENTRY_KEYS) continue;
    const readers = adapters
      .all()
      .filter((adapter) => adapter.keys && key in adapter.keys)
      .map((adapter) => adapter.ecosystem);
    if (readers.length > 0) {
      const eco = readers.find((name) => listed.includes(name)) ?? readers[0]!;
      report(
        "WORKSPACE_UNKNOWN_KEY",
        `${where}: '${[...at, key].join(".")}' is a setting of the ${readers.join(" / ")} ecosystem, ` +
          `which is never written flat on an entry. Write it at the anchor ` +
          `(ecosystem: { ${eco}: { ".": { ${key}: … } } }) or for every ${eco} anchor under ` +
          `'release.ecosystems.${eco}'.`,
        [...at, key],
      );
      continue;
    }
    const names = Object.keys(UNIT_ENTRY_KEYS);
    const near = nearMiss(key, names);
    report(
      "WORKSPACE_UNKNOWN_KEY",
      `${where}: unknown key '${[...at, key].join(".")}'.` +
        (near ? ` Did you mean '${near}'?` : ` Known keys: ${names.map((n) => `'${n}'`).join(", ")}.`),
      [...at, key],
    );
  }
}

/**
 * Settings read against one ecosystem's keys: a key the ecosystem does not read
 * is named with the ecosystem, and one it does is read by its declared type.
 */
function readEcosystemSettings(
  raw: unknown,
  ecosystem: string,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a mapping of the ${ecosystem} ecosystem's settings.`,
      at,
    );
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const adapter = adapters.get(ecosystem);
  // An ecosystem no adapter serves is reported once, where it is named.
  if (!adapter) return {};
  const keys = adapter.keys ?? {};
  const names = Object.keys(keys);
  for (const key of Object.keys(fields)) {
    if (key in keys) continue;
    const near = nearMiss(key, names);
    report(
      "WORKSPACE_UNKNOWN_KEY",
      `${where}: '${[...at, key].join(".")}' is not read by the ${ecosystem} ecosystem.` +
        (near
          ? ` Did you mean '${near}'?`
          : names.length > 0
            ? ` It reads ${names.map((n) => `'${n}'`).join(", ")}.`
            : ` It reads no settings.`),
      [...at, key],
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(keys)) {
    if (fields[key] === null) {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${[...at, key].join(".")}' has no value.`, [...at, key]);
      continue;
    }
    if (schema.type === "directory") {
      const value = readWorkspaceDirectory(fields[key], where, [...at, key], report);
      if (value !== undefined) out[key] = value;
      continue;
    }
    Object.assign(out, readKnownKeys({ [key]: fields[key] }, { [key]: schema }, where, at, report));
  }
  return out;
}

/** A literal workspace-relative directory, normalized (`.` the workspace root);
 *  a pattern or a path leaving the workspace is `WORKSPACE_ANCHOR_INVALID`.
 *  Whether it exists is the tree's question. */
function readWorkspaceDirectory(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): string | undefined {
  const value = readString(raw, where, at, report);
  if (value === undefined) return undefined;
  const normalized = normalizeAnchor(value);
  if (normalized === undefined) {
    report(
      "WORKSPACE_ANCHOR_INVALID",
      `${where}: '${at.join(".")}' is ${JSON.stringify(value)}, which is not a literal directory ` +
        `inside the workspace. Write a workspace-relative path with no pattern and no '..' ` +
        `('.' for the workspace root).`,
      at,
    );
  }
  return normalized;
}

/** `release.ecosystems`: per ecosystem, its block defaults. */
function readEcosystemDefaults(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
  options: ReadReleaseOptions,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a map of ecosystem to its settings, e.g. { telo: { registry: oci://ghcr.io/acme } }.`,
      at,
    );
    return out;
  }
  for (const [name, settings] of Object.entries(raw as Record<string, unknown>)) {
    const nameAt = [...at, name];
    if (!adapters.has(name)) {
      reportUnavailable(name, where, nameAt, report, adapters, options);
      continue;
    }
    const read = readEcosystemSettings(settings, name, where, nameAt, report, adapters);
    if (read) out.set(name, read);
  }
  return out;
}

function reportUnavailable(
  name: string,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
  options: ReadReleaseOptions,
): void {
  const host = options.ecosystemHosts?.[name];
  report(
    "WORKSPACE_ECOSYSTEM_UNAVAILABLE",
    `${where}: the '${name}' ecosystem is not served here — no adapter for it is registered ` +
      `in this host, so it cannot be planned. ` +
      (host
        ? `Run the release through ${host}.`
        : `Run the release through a host that serves '${name}'. Served here: ${adapters
            .all()
            .map((adapter) => adapter.ecosystem)
            .join(", ")}.`),
    at,
  );
}

/**
 * What the text alone decides about a unit: where its version is, and — with no
 * ecosystem — whether it declares a payload. An exclusion supplies nothing and
 * is not judged; nor is an entry naming an ecosystem no adapter serves, whose
 * unavailability is the one report.
 */
function checkResolvable(
  entry: UnitEntry,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
): void {
  if (entry.path.startsWith("!")) return;
  const listed = entry.ecosystem ? [...entry.ecosystem] : [];
  if (listed.some(([name]) => !adapters.has(name))) return;
  const name = `'${at.join(".")}' (${entry.path})`;

  if (!entry.ecosystem && !entry.payload) {
    report(
      "WORKSPACE_UNIT_PAYLOAD_EMPTY",
      `${where}: ${name} lists no ecosystem and declares no 'payload:', so nothing it ships can ` +
        `be digested. List the ecosystem it ships through, declare 'payload:', or exclude it with '!'.`,
      at,
    );
  }
  if (entry.version) return;
  const defaulting = listed.flatMap(([ecosystem, anchors]) =>
    adapters.get(ecosystem)!.versionFile ? anchors.map((anchor) => `${ecosystem} at ${anchor}`) : [],
  );
  if (defaulting.length === 1) return;
  report(
    "WORKSPACE_UNIT_VERSION_UNRESOLVED",
    defaulting.length === 0
      ? `${where}: ${name} declares no 'version:' and ${
          listed.length === 0
            ? "lists no ecosystem"
            : `none of its ecosystems (${listed.map(([e]) => e).join(", ")}) keeps a version`
        }. Declare 'version:', naming the file that holds it.`
      : `${where}: ${name} declares no 'version:' and ${defaulting.length} anchors keep one ` +
          `(${defaulting.join(", ")}). Declare 'version:', naming the one that holds the unit's version.`,
    at,
  );
}

function readEcosystem(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
  adapters: AdapterRegistry,
  options: ReadReleaseOptions,
):
  | {
      anchors: ReadonlyMap<string, readonly string[]>;
      settings: ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, unknown>>>>;
    }
  | undefined {
  if (raw === undefined || raw === null) return undefined;
  const out = new Map<string, string[]>();
  const settings = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();
  const add = (
    name: unknown,
    anchors: readonly unknown[],
    nameAt: (string | number)[],
    form: "single" | "list" | "map",
    anchorSettings?: Readonly<Record<string, unknown>>,
  ) => {
    if (typeof name !== "string" || name === "") {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${nameAt.join(".")}' must name an ecosystem.`, nameAt);
      return;
    }
    if (RESERVED_ECOSYSTEMS.has(name)) {
      report(
        "WORKSPACE_INVALID_VALUE",
        `${where}: '${name}' is reserved for a declared payload and names no ecosystem. ` +
          `Declare a payload with the entry's 'payload:' key.`,
        nameAt,
      );
      return;
    }
    if (out.has(name)) {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${name}' is listed twice.`, nameAt);
      return;
    }
    if (!adapters.has(name)) reportUnavailable(name, where, nameAt, report, adapters, options);
    const normalized: string[] = [];
    const bySetting = new Map<string, Readonly<Record<string, unknown>>>();
    for (const [i, anchor] of anchors.entries()) {
      const anchorAt = form === "list" ? [...nameAt, i] : form === "map" ? [...nameAt, String(anchor)] : nameAt;
      const valid = normalizeAnchor(anchor);
      if (valid === undefined) {
        report(
          "WORKSPACE_ANCHOR_INVALID",
          `${where}: anchor ${JSON.stringify(anchor)} of '${name}' is not a literal directory inside ` +
            `the unit. An anchor is a unit-relative path with no pattern and no '..' (or '.' for the ` +
            `unit itself).`,
          anchorAt,
        );
        continue;
      }
      if (normalized.includes(valid)) {
        report("WORKSPACE_INVALID_VALUE", `${where}: anchor '${valid}' of '${name}' is listed twice.`, anchorAt);
        continue;
      }
      normalized.push(valid);
      if (form === "map") {
        const read = readEcosystemSettings(
          (anchorSettings as Record<string, unknown>)[String(anchor)],
          name,
          where,
          anchorAt,
          report,
          adapters,
        );
        if (read && Object.keys(read).length > 0) bySetting.set(valid, read);
      }
    }
    out.set(name, normalized);
    if (bySetting.size > 0) settings.set(name, bySetting);
  };

  if (typeof raw === "string") {
    add(raw, ["."], at, "single");
  } else if (Array.isArray(raw)) {
    for (const [i, name] of raw.entries()) add(name, ["."], [...at, i], "single");
  } else if (typeof raw === "object") {
    for (const [name, anchors] of Object.entries(raw as Record<string, unknown>)) {
      const nameAt = [...at, name];
      if (typeof anchors === "string") add(name, [anchors], nameAt, "single");
      else if (Array.isArray(anchors) && anchors.length > 0) add(name, anchors, nameAt, "list");
      else if (anchors !== null && typeof anchors === "object" && !Array.isArray(anchors) && Object.keys(anchors).length > 0)
        add(name, Object.keys(anchors), nameAt, "map", anchors as Record<string, unknown>);
      else
        report(
          "WORKSPACE_INVALID_VALUE",
          `${where}: '${nameAt.join(".")}' must be an anchor directory, a list of them, or a map ` +
            `of anchor directory to its settings.`,
          nameAt,
        );
    }
  } else {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be an ecosystem name, a list of them, or a map of ` +
        `ecosystem to anchor directory.`,
      at,
    );
  }
  return out.size > 0 ? { anchors: out, settings } : undefined;
}

/** A literal unit-relative directory, normalized; `undefined` when it is a
 *  pattern, leaves the unit, or is absolute. */
export function normalizeAnchor(anchor: unknown): string | undefined {
  if (typeof anchor !== "string" || anchor.trim() === "") return undefined;
  const posix = anchor.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || /[*?!]/.test(posix)) return undefined;
  const segments = posix.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.length === 0 ? "." : segments.join("/");
}

function readRelativeFile(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): string | undefined {
  const value = readString(raw, where, at, report);
  if (value === undefined) return undefined;
  const normalized = normalizeAnchor(value);
  if (normalized === undefined || normalized === ".") {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a file inside the unit, with no pattern and no '..'.`,
      at,
    );
    return undefined;
  }
  return normalized;
}

function readPointer(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): string | undefined {
  const value = readString(raw, where, at, report);
  if (value === undefined) return undefined;
  if (!value.startsWith("/")) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a JSON pointer (RFC 6901) starting with '/', e.g. /version.`,
      at,
    );
    return undefined;
  }
  return value;
}

function readVersionLocation(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): VersionLocationSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const file = readRelativeFile(raw, where, at, report);
    return file ? { file } : undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    reportUnknownKeys(fields, ["file", "pointer"], where, at, report);
    const file = readRelativeFile(fields.file, where, [...at, "file"], report);
    const pointer = readPointer(fields.pointer, where, [...at, "pointer"], report);
    if (!file || !pointer) {
      if (fields.file === undefined || fields.pointer === undefined) {
        report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' needs both 'file:' and 'pointer:'.`, at);
      }
      return undefined;
    }
    return { file, pointer };
  }
  report(
    "WORKSPACE_INVALID_VALUE",
    `${where}: '${at.join(".")}' must be a unit-relative file, or { file, pointer }.`,
    at,
  );
  return undefined;
}

function readPayload(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): PayloadSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const patterns = readStringList(raw, where, at, report);
    if (patterns && patterns.length === 0) {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' is empty, so it selects no file.`, at);
      return undefined;
    }
    return patterns ? { patterns } : undefined;
  }
  if (typeof raw === "object") {
    const fields = raw as Record<string, unknown>;
    reportUnknownKeys(fields, ["command"], where, at, report);
    const command = readString(fields.command, where, [...at, "command"], report);
    if (command === undefined && fields.command === undefined) {
      report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' needs 'command:'.`, at);
    }
    return command ? { command } : undefined;
  }
  report(
    "WORKSPACE_INVALID_VALUE",
    `${where}: '${at.join(".")}' must be a list of unit-relative patterns, or { command }.`,
    at,
  );
  return undefined;
}

function readVersionFiles(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): readonly VersionFileSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a list of unit-relative patterns or { path, pointer }.`,
      at,
    );
    return undefined;
  }
  const out: VersionFileSpec[] = [];
  for (const [index, item] of raw.entries()) {
    const itemAt = [...at, index];
    if (typeof item === "string") {
      const pattern = readString(item, where, itemAt, report);
      if (pattern) out.push({ pattern });
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const fields = item as Record<string, unknown>;
      reportUnknownKeys(fields, ["path", "pointer"], where, itemAt, report);
      const path = readRelativeFile(fields.path, where, [...itemAt, "path"], report);
      const pointer = readPointer(fields.pointer, where, [...itemAt, "pointer"], report);
      if (path && pointer) out.push({ path, pointer });
      else if (fields.path === undefined || fields.pointer === undefined) {
        report("WORKSPACE_INVALID_VALUE", `${where}: '${itemAt.join(".")}' needs both 'path:' and 'pointer:'.`, itemAt);
      }
      continue;
    }
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${itemAt.join(".")}' must be a unit-relative pattern, or { path, pointer }.`,
      itemAt,
    );
  }
  return out;
}

function readBumpLevel(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): BumpLevel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isBumpLevel(raw)) {
    report("WORKSPACE_INVALID_VALUE", `${where}: '${at.join(".")}' must be patch, minor or major.`, at);
    return undefined;
  }
  return raw;
}

function readGroups(
  raw: unknown,
  where: string,
  at: (string | number)[],
  report: MarkerReport,
): ReadonlyMap<string, readonly UnitKey[]> {
  const groups = new Map<string, UnitKey[]>();
  if (raw === undefined || raw === null) return groups;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report(
      "WORKSPACE_INVALID_VALUE",
      `${where}: '${at.join(".")}' must be a map of group name to a list of unit keys.`,
      at,
    );
    return groups;
  }
  const owner = new Map<UnitKey, string>();
  for (const [name, members] of Object.entries(raw as Record<string, unknown>)) {
    const list = readStringList(members, where, [...at, name], report);
    if (!list) {
      if (members === null || members === undefined) {
        report("WORKSPACE_INVALID_VALUE", `${where}: '${[...at, name].join(".")}' must be a list of unit keys.`, [...at, name]);
      }
      continue;
    }
    const keys: UnitKey[] = [];
    for (const [index, member] of list.entries()) {
      const key = normalizeUnitKey(member);
      const other = owner.get(key);
      if (other !== undefined) {
        report(
          "WORKSPACE_INVALID_VALUE",
          `${where}: '${key}' is in groups '${other}' and '${name}'. A unit shares one version, so ` +
            `it belongs to at most one group.`,
          [...at, name, index],
        );
        continue;
      }
      owner.set(key, name);
      keys.push(key);
    }
    groups.set(name, keys);
  }
  return groups;
}

export interface ReleaseMarkerRead {
  readonly release?: ReleaseSettings;
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}

/**
 * Read a marker's `release:` block alone, for a host that reads no other block.
 * Other top-level blocks belong to other tools and are left unread.
 */
export function readReleaseMarker(
  text: string,
  where: string,
  adapters: readonly EcosystemAdapter[],
  options: ReadReleaseOptions = {},
): ReleaseMarkerRead {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const report: MarkerReport = (code, message, path, severity = "error") => {
    diagnostics.push({ code, severity, message, path });
  };
  const record = parseMarker(text, where, report);
  const release = record
    ? readReleaseBlock(record.release, where, report, new AdapterRegistry(adapters), options)
    : undefined;
  return { ...(release ? { release } : {}), diagnostics };
}

/**
 * The release settings, or a throw naming what is missing — for a release
 * command, for which any error is fatal and an absent block is itself one.
 */
export function requireReleaseSettings(
  read: { readonly release?: ReleaseSettings; readonly diagnostics: readonly WorkspaceDiagnostic[] },
  where: string,
): ReleaseSettings {
  const first = read.diagnostics.find((d) => d.severity === "error");
  if (first) throw new WorkspaceConfigError(first.message);
  if (!read.release || read.release.units.length === 0) {
    throw new WorkspaceConfigError(
      `${where} declares no 'release.units', so nothing is released. List the units:\n\n` +
        `  release:\n    units:\n      - { path: packages/*, ecosystem: npm }\n`,
    );
  }
  return read.release;
}

export { WORKSPACE_FILENAME };

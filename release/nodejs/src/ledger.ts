/**
 * `.changes/ledger.yaml` — what each unit looks like **as published**.
 *
 * It lets a gate answer "does my payload differ from what is published at my
 * current version?" with no network call, no merge base and no credentials, so
 * the PR gate and the publish gate compute the same number. It is a cache, never
 * the authority: `verify` reconciles it against the registries, and a missing
 * entry means nothing is published — not drift.
 *
 * Layers nest by ecosystem and anchor (`npm: { nodejs: <digest> }`); an anchor
 * whose ecosystem builds several layers holds a map of them, and a declared
 * payload sits under the reserved key `payload`. No key joins an ecosystem and a
 * path in one string.
 *
 * A **candidate** record sits beside the final entry: a candidate leaves the
 * final entry alone, so the final is always planned from final entries.
 *
 * The shape written before units — a top-level `modules:` map whose layers are
 * flat, plus an optional top-level `registry:` — is read only when the host
 * says how its flat layers nest (`LegacyLedgerLayers`), and is never written.
 */

import { Document, parseDocument } from "yaml";
import { isReleaseVersion, isUnitVersion } from "./bump-level.js";
import { normalizeUnitKey, type UnitKey } from "./fragment.js";

export const LEDGER_PATH = ".changes/ledger.yaml";

/** The reserved layer key a unit's declared `payload:` is recorded under. */
export const PAYLOAD_LAYER = "payload";

/** One anchor's digest, or — for an ecosystem building several layers per
 *  anchor — a map of layer key to digest. */
export type AnchorDigest = string | Readonly<Record<string, string>>;

export interface UnitLayers {
  /** `<ecosystem>: { <anchor>: <digest> }`. */
  readonly ecosystems: Readonly<Record<string, Readonly<Record<string, AnchorDigest>>>>;
  /** The declared payload's digest. */
  readonly payload?: string;
}

export const EMPTY_LAYERS: UnitLayers = { ecosystems: {} };

export interface CandidateRecord {
  readonly version: string;
  readonly layers: UnitLayers;
}

export interface LedgerEntry {
  /** The final version these digests were taken at. Absent only for a unit
   *  never published as a final, whose entry holds a candidate alone. */
  readonly version?: string;
  /** The publish destination base the digests were taken against, for an
   *  ecosystem whose bytes depend on it. */
  readonly registry?: string;
  readonly layers: UnitLayers;
  readonly candidate?: CandidateRecord;
}

export interface Ledger {
  readonly units: ReadonlyMap<UnitKey, LedgerEntry>;
}

export class LedgerError extends Error {}

export const EMPTY_LEDGER: Ledger = { units: new Map() };

/** How a host nests a pre-unit ledger's flat layer map, keyed by unit. */
export type LegacyLedgerLayers = (unit: UnitKey, flat: Readonly<Record<string, string>>) => UnitLayers;

export interface ParseLedgerOptions {
  readonly legacyLayers?: LegacyLedgerLayers;
}

export function parseLedger(text: string, where: string, options: ParseLedgerOptions = {}): Ledger {
  let value: unknown;
  try {
    value = parseDocument(text).toJSON();
  } catch (err) {
    throw new LedgerError(
      `${where} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (value === null) return EMPTY_LEDGER;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerError(`${where} must be a YAML mapping.`);
  }
  const record = value as Record<string, unknown>;
  if ("modules" in record || "registry" in record) return parseLegacy(record, where, options);

  for (const key of Object.keys(record)) {
    if (key !== "units") {
      throw new LedgerError(`${where}: unknown field '${key}'. The ledger carries 'units:'.`);
    }
  }
  const rawUnits = record.units;
  if (rawUnits === undefined || rawUnits === null) return EMPTY_LEDGER;
  const units = new Map<UnitKey, LedgerEntry>();
  for (const [key, raw] of mappingEntries(rawUnits, `${where}: 'units'`)) {
    units.set(normalizeUnitKey(key), readEntry(raw, `${where}: entry '${key}'`));
  }
  return { units };
}

function readEntry(raw: unknown, at: string): LedgerEntry {
  const entry = asMapping(raw, at);
  for (const field of Object.keys(entry)) {
    if (!["version", "registry", "layers", "candidate"].includes(field)) {
      throw new LedgerError(
        `${at} has unknown field '${field}'. An entry carries 'version:', 'registry:', ` +
          `'layers:' and 'candidate:'.`,
      );
    }
  }
  if (entry.registry !== undefined && typeof entry.registry !== "string") {
    throw new LedgerError(`${at} has a non-string 'registry'.`);
  }
  const candidate = entry.candidate === undefined ? undefined : readCandidate(entry.candidate, at);
  if (entry.version === undefined && candidate) {
    if (entry.layers !== undefined) {
      throw new LedgerError(
        `${at} records layers but no 'version'. Layers are taken at a published version.`,
      );
    }
    return { layers: EMPTY_LAYERS, candidate, ...registryOf(entry) };
  }
  if (!isReleaseVersion(entry.version)) {
    throw new LedgerError(
      `${at} has no major.minor.patch 'version'. The ledger records the version each digest ` +
        `was taken at; without it the digest says nothing.`,
    );
  }
  return {
    version: entry.version,
    ...registryOf(entry),
    layers: readLayers(entry.layers, at),
    ...(candidate ? { candidate } : {}),
  };
}

function registryOf(entry: Record<string, unknown>): { registry?: string } {
  return typeof entry.registry === "string" ? { registry: entry.registry } : {};
}

function readCandidate(raw: unknown, at: string): CandidateRecord {
  const candidate = asMapping(raw, `${at}: 'candidate'`);
  for (const field of Object.keys(candidate)) {
    if (field !== "version" && field !== "layers") {
      throw new LedgerError(
        `${at}: 'candidate' has unknown field '${field}'. It carries 'version:' and 'layers:'.`,
      );
    }
  }
  if (!isUnitVersion(candidate.version) || isReleaseVersion(candidate.version)) {
    throw new LedgerError(
      `${at}: 'candidate.version' must be a candidate version, '<final>-<id>.<k>'.`,
    );
  }
  return { version: candidate.version, layers: readLayers(candidate.layers, `${at}: 'candidate'`) };
}

function readLayers(raw: unknown, at: string): UnitLayers {
  if (raw === undefined || raw === null) return EMPTY_LAYERS;
  const ecosystems: Record<string, Record<string, AnchorDigest>> = {};
  let payload: string | undefined;
  for (const [ecosystem, anchors] of mappingEntries(raw, `${at}: 'layers'`)) {
    if (ecosystem === PAYLOAD_LAYER) {
      if (typeof anchors !== "string") {
        throw new LedgerError(`${at}: layer '${PAYLOAD_LAYER}' is not a digest string.`);
      }
      payload = anchors;
      continue;
    }
    const byAnchor: Record<string, AnchorDigest> = {};
    for (const [anchor, digest] of mappingEntries(anchors, `${at}: layer '${ecosystem}'`)) {
      if (typeof digest === "string") {
        byAnchor[anchor] = digest;
        continue;
      }
      const keyed: Record<string, string> = {};
      for (const [layer, value] of mappingEntries(digest, `${at}: layer '${ecosystem}' '${anchor}'`)) {
        if (typeof value !== "string") {
          throw new LedgerError(
            `${at}: layer '${ecosystem}' '${anchor}' '${layer}' is not a digest string.`,
          );
        }
        keyed[layer] = value;
      }
      byAnchor[anchor] = keyed;
    }
    ecosystems[ecosystem] = byAnchor;
  }
  return { ecosystems, ...(payload !== undefined ? { payload } : {}) };
}

function parseLegacy(
  record: Record<string, unknown>,
  where: string,
  options: ParseLedgerOptions,
): Ledger {
  if (!options.legacyLayers) {
    throw new LedgerError(
      `${where} is written in the module ledger shape (a top-level 'modules:' map), which this ` +
        `host cannot re-key into units. Rewrite it with a host serving the ecosystem that wrote it.`,
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "registry" && key !== "modules") {
      throw new LedgerError(
        `${where}: unknown field '${key}'. The ledger carries 'registry:' and 'modules:'.`,
      );
    }
  }
  const inherited = record.registry;
  if (inherited !== undefined && typeof inherited !== "string") {
    throw new LedgerError(`${where}: 'registry' must be the publish destination base, as a string.`);
  }
  const units = new Map<UnitKey, LedgerEntry>();
  if (record.modules === undefined || record.modules === null) return { units };
  for (const [key, raw] of mappingEntries(record.modules, `${where}: 'modules'`)) {
    const at = `${where}: entry '${key}'`;
    const entry = asMapping(raw, at);
    for (const field of Object.keys(entry)) {
      if (field !== "version" && field !== "registry" && field !== "layers") {
        throw new LedgerError(
          `${at} has unknown field '${field}'. An entry carries 'version:', 'registry:' and 'layers:'.`,
        );
      }
    }
    if (entry.registry !== undefined && typeof entry.registry !== "string") {
      throw new LedgerError(`${at} has a non-string 'registry'.`);
    }
    if (!isReleaseVersion(entry.version)) {
      throw new LedgerError(
        `${at} has no major.minor.patch 'version'. The ledger records the version each digest ` +
          `was taken at; without it the digest says nothing.`,
      );
    }
    const flat: Record<string, string> = {};
    if (entry.layers !== undefined && entry.layers !== null) {
      for (const [layer, digest] of mappingEntries(entry.layers, `${at}: 'layers'`)) {
        if (typeof digest !== "string") {
          throw new LedgerError(`${at} layer '${layer}' is not a digest string.`);
        }
        flat[layer] = digest;
      }
    }
    const unit = normalizeUnitKey(key);
    const registry = (entry.registry as string | undefined) ?? (inherited as string | undefined);
    units.set(unit, {
      version: entry.version,
      ...(registry ? { registry } : {}),
      layers: options.legacyLayers(unit, flat),
    });
  }
  return { units };
}

function asMapping(raw: unknown, at: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LedgerError(`${at} must be a mapping.`);
  }
  return raw as Record<string, unknown>;
}

function mappingEntries(raw: unknown, at: string): [string, unknown][] {
  return Object.entries(asMapping(raw, at));
}

/**
 * Render the ledger. Keys are sorted at every level so a release's diff shows
 * only the units that moved.
 */
export function serializeLedger(ledger: Ledger): string {
  const units: Record<string, unknown> = {};
  for (const key of [...ledger.units.keys()].sort()) {
    const entry = ledger.units.get(key)!;
    units[key] = {
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.registry ? { registry: entry.registry } : {}),
      ...(entry.version !== undefined ? { layers: renderLayers(entry.layers) } : {}),
      ...(entry.candidate
        ? {
            candidate: {
              version: entry.candidate.version,
              layers: renderLayers(entry.candidate.layers),
            },
          }
        : {}),
    };
  }
  const doc = new Document({ units });
  return (
    "# Generated by `release apply` — what each unit looks like as published.\n" +
    "# A cache of the registries' answers, so a PR gate needs no credentials.\n" +
    "# `release verify` reconciles it against the registries.\n" +
    doc.toString({ lineWidth: 0 })
  );
}

function renderLayers(layers: UnitLayers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ecosystem of Object.keys(layers.ecosystems).sort()) {
    const anchors = layers.ecosystems[ecosystem]!;
    const byAnchor: Record<string, unknown> = {};
    for (const anchor of Object.keys(anchors).sort()) {
      const digest = anchors[anchor]!;
      if (typeof digest === "string") {
        byAnchor[anchor] = digest;
        continue;
      }
      const keyed: Record<string, string> = {};
      for (const layer of Object.keys(digest).sort()) keyed[layer] = digest[layer]!;
      byAnchor[anchor] = keyed;
    }
    out[ecosystem] = byAnchor;
  }
  if (layers.payload !== undefined) out[PAYLOAD_LAYER] = layers.payload;
  return out;
}

/** A layer whose digest differs between two readings, or that exists in only
 *  one. `path` is `[ecosystem, anchor]`, `[ecosystem, anchor, layer]` or
 *  `["payload"]`. */
export interface LayerChange {
  readonly path: readonly string[];
  readonly before?: string;
  readonly after?: string;
}

/** Every digest of a reading with its path, in key order. */
export function layerDigests(layers: UnitLayers): [readonly string[], string][] {
  const out: [readonly string[], string][] = [];
  for (const ecosystem of Object.keys(layers.ecosystems).sort()) {
    const anchors = layers.ecosystems[ecosystem]!;
    for (const anchor of Object.keys(anchors).sort()) {
      const digest = anchors[anchor]!;
      if (typeof digest === "string") {
        out.push([[ecosystem, anchor], digest]);
        continue;
      }
      for (const layer of Object.keys(digest).sort()) {
        out.push([[ecosystem, anchor, layer], digest[layer]!]);
      }
    }
  }
  if (layers.payload !== undefined) out.push([[PAYLOAD_LAYER], layers.payload]);
  return out;
}

/** Every layer on which two readings disagree. Empty means the payloads are
 *  byte-identical. */
export function diffLayers(before: UnitLayers, after: UnitLayers): LayerChange[] {
  const index = (layers: UnitLayers) =>
    new Map(layerDigests(layers).map(([path, digest]) => [path.join("\0"), { path, digest }]));
  const a = index(before);
  const b = index(after);
  const changes: LayerChange[] = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(id);
    const y = b.get(id);
    if (x?.digest === y?.digest) continue;
    changes.push({
      path: (x ?? y)!.path,
      ...(x ? { before: x.digest } : {}),
      ...(y ? { after: y.digest } : {}),
    });
  }
  return changes;
}

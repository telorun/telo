/**
 * `.changes/ledger.yaml` — what each module looks like **as published**.
 *
 * It exists so a gate can answer "does my payload differ from what is published
 * at my current version?" with no network call, no merge base and no
 * credentials: a fork's PR runs the identical computation the release job runs.
 * That is the load-bearing property — the PR gate and the publish gate compute
 * the same number.
 *
 * **It is a cache, never the authority.** A committed digest can disagree with
 * the registry — a hand edit, an `apply` whose publish then failed, a push made
 * outside the pipeline — so `telo publish` still reads the registry, and
 * `telo release verify` reconciles the two on demand. A *missing* entry is not
 * drift: it means nothing is published, which is the correct reading for a
 * module that has never shipped.
 *
 * **It records the registry base**, because canonicalizing a relative `imports:`
 * source writes the destination into the manifest layer — so the digests below
 * are digests *against that base*, and comparing them to digests taken against
 * another one would be comparing two different artifacts.
 */

import { Document, parseDocument } from "yaml";
import { isReleaseVersion } from "./bump-level.js";
import { normalizeModuleKey, type ModuleKey } from "./fragment.js";
import type { LayerDigests } from "./payload-digest.js";

export const LEDGER_PATH = ".changes/ledger.yaml";

export interface LedgerEntry {
  /** The version these digests were taken at — the tag the artifact published
   *  under. */
  readonly version: string;
  readonly layers: LayerDigests;
}

export interface Ledger {
  /**
   * The publish destination base the digests were taken against
   * (`oci://ghcr.io/telorun`). Absent in a workspace that has published nothing
   * yet, which is why it is optional rather than required — but a `check` that
   * has entries and no base cannot reproduce them, and says so.
   */
  readonly registry?: string;
  readonly modules: ReadonlyMap<ModuleKey, LedgerEntry>;
}

export class LedgerError extends Error {}

export const EMPTY_LEDGER: Ledger = { modules: new Map() };

export function parseLedger(text: string, where: string): Ledger {
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

  for (const key of Object.keys(record)) {
    if (key !== "registry" && key !== "modules") {
      throw new LedgerError(
        `${where}: unknown field '${key}'. The ledger carries 'registry:' and 'modules:'.`,
      );
    }
  }

  const registry = record.registry;
  if (registry !== undefined && typeof registry !== "string") {
    throw new LedgerError(`${where}: 'registry' must be the publish destination base, as a string.`);
  }

  const rawModules = record.modules;
  if (rawModules === undefined || rawModules === null) return { ...(registry ? { registry } : {}), modules: new Map() };
  if (typeof rawModules !== "object" || Array.isArray(rawModules)) {
    throw new LedgerError(`${where}: 'modules' must be a mapping of module path to entry.`);
  }

  const modules = new Map<ModuleKey, LedgerEntry>();
  for (const [key, raw] of Object.entries(rawModules as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LedgerError(`${where}: entry '${key}' must be a mapping.`);
    }
    const entry = raw as Record<string, unknown>;
    if (!isReleaseVersion(entry.version)) {
      throw new LedgerError(
        `${where}: entry '${key}' has no major.minor.patch 'version'. The ledger records the ` +
          `version each digest was taken at; without it the digest says nothing.`,
      );
    }
    const layers: Record<string, string> = {};
    const rawLayers = entry.layers;
    if (rawLayers !== undefined && rawLayers !== null) {
      if (typeof rawLayers !== "object" || Array.isArray(rawLayers)) {
        throw new LedgerError(`${where}: entry '${key}' has a non-mapping 'layers'.`);
      }
      for (const [layer, digest] of Object.entries(rawLayers as Record<string, unknown>)) {
        if (typeof digest !== "string") {
          throw new LedgerError(`${where}: entry '${key}' layer '${layer}' is not a digest string.`);
        }
        layers[layer] = digest;
      }
    }
    modules.set(normalizeModuleKey(key), { version: entry.version, layers });
  }

  return { ...(registry ? { registry } : {}), modules };
}

/**
 * Render the ledger.
 *
 * Keys are sorted so a release's ledger diff shows only the modules that moved
 * — the file is committed and reviewed, and a map whose order followed insertion
 * would reorder wholesale on every run.
 */
export function serializeLedger(ledger: Ledger): string {
  const modules: Record<string, unknown> = {};
  for (const key of [...ledger.modules.keys()].sort()) {
    const entry = ledger.modules.get(key)!;
    const layers: Record<string, string> = {};
    for (const layer of Object.keys(entry.layers).sort()) layers[layer] = entry.layers[layer];
    modules[key] = { version: entry.version, layers };
  }
  const doc = new Document({
    ...(ledger.registry ? { registry: ledger.registry } : {}),
    modules,
  });
  return (
    "# Generated by `telo release apply` — what each module looks like as published.\n" +
    "# A cache of the registry's answer, so a PR gate needs no credentials.\n" +
    "# `telo release verify` reconciles it against the registry.\n" +
    doc.toString({ lineWidth: 0 })
  );
}

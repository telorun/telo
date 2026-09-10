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
 * **Every entry records its own registry base**, because canonicalizing a
 * relative `imports:` source writes the destination into the manifest layer — so
 * each digest is a digest *against that base*, and comparing it to one taken
 * against another would be comparing two different artifacts.
 *
 * Per entry rather than one top-level base with per-entry deltas: a workspace
 * whose `release.modules` entries each author a destination has no meaningful
 * top-level base, an absent one already means *nothing has been published yet*,
 * and the agreement check returns early on that — so the multi-destination
 * workspace would be the one whose bases are never compared. The file is
 * generated and never hand-maintained, so the redundancy costs nothing and it
 * removes the "differs from what?" question and the absent-versus-unknown
 * conflation together. A **top-level `registry:` is a legacy form the reader
 * accepts and never writes**, applied to every entry: the credential-free PR
 * gate reads whatever ledger is committed on the branch, and that stays in the
 * old shape until a release regenerates it.
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
  /** The publish destination base these digests were taken against
   *  (`oci://ghcr.io/telorun`). Absent only in a ledger written before the base
   *  was recorded at all. */
  readonly registry?: string;
  readonly layers: LayerDigests;
}

export interface Ledger {
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

  // The legacy top-level base: read and applied to every entry, never written.
  const inherited = record.registry;
  if (inherited !== undefined && typeof inherited !== "string") {
    throw new LedgerError(`${where}: 'registry' must be the publish destination base, as a string.`);
  }

  const rawModules = record.modules;
  if (rawModules === undefined || rawModules === null) return { modules: new Map() };
  if (typeof rawModules !== "object" || Array.isArray(rawModules)) {
    throw new LedgerError(`${where}: 'modules' must be a mapping of module path to entry.`);
  }

  const modules = new Map<ModuleKey, LedgerEntry>();
  for (const [key, raw] of Object.entries(rawModules as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LedgerError(`${where}: entry '${key}' must be a mapping.`);
    }
    const entry = raw as Record<string, unknown>;
    for (const field of Object.keys(entry)) {
      if (field !== "version" && field !== "registry" && field !== "layers") {
        throw new LedgerError(
          `${where}: entry '${key}' has unknown field '${field}'. An entry carries 'version:', ` +
            `'registry:' and 'layers:'.`,
        );
      }
    }
    if (entry.registry !== undefined && typeof entry.registry !== "string") {
      throw new LedgerError(
        `${where}: entry '${key}' has a non-string 'registry'. It is the publish destination base ` +
          `the digests beside it were taken against.`,
      );
    }
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
    const registry = (entry.registry as string | undefined) ?? inherited;
    modules.set(normalizeModuleKey(key), {
      version: entry.version,
      ...(registry ? { registry } : {}),
      layers,
    });
  }

  return { modules };
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
    modules[key] = {
      version: entry.version,
      ...(entry.registry ? { registry: entry.registry } : {}),
      layers,
    };
  }
  const doc = new Document({ modules });
  return (
    "# Generated by `telo release apply` — what each module looks like as published.\n" +
    "# A cache of the registry's answer, so a PR gate needs no credentials.\n" +
    "# `telo release verify` reconciles it against the registry.\n" +
    doc.toString({ lineWidth: 0 })
  );
}

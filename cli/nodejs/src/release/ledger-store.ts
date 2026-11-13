/**
 * The ledger as a Telo host reads it: the store is `@telorun/release`'s, and a
 * ledger still in the module shape — a top-level `modules:` map of flat layers —
 * is re-keyed into units by the `telo` ecosystem's rule.
 */

import { TELO_ECOSYSTEM, teloLegacyLedgerLayers, type LayerDigests } from "@telorun/analyzer";
import { dockerAdapter, type Ledger, type UnitKey, type UnitLayers } from "@telorun/release";
import { readLedger as readStoredLedger } from "@telorun/release/node";

export { writeLedger } from "@telorun/release/node";

/** How a Telo host parses the ledger. */
export const TELO_LEDGER_OPTIONS = { legacyLayers: teloLegacyLedgerLayers } as const;

export function readLedger(root: string): Ledger {
  return readStoredLedger(root, TELO_LEDGER_OPTIONS);
}

/** A module's flat artifact layers nested under the unit's anchors. */
export function moduleUnitLayers(key: UnitKey, flat: LayerDigests): UnitLayers {
  return teloLegacyLedgerLayers(key, flat);
}

/** The flat artifact layers a module's ledger layers hold. */
export function moduleLayersOf(layers: UnitLayers): LayerDigests {
  const own = layers.ecosystems[TELO_ECOSYSTEM]?.["."];
  const image = layers.ecosystems[dockerAdapter.ecosystem]?.["."];
  return {
    ...(typeof own === "object" ? own : {}),
    ...(typeof image === "string" ? { image } : {}),
  };
}

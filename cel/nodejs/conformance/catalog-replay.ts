/**
 * `catalog.json`: where the engine's catalog answers the recording, and where it does not.
 *
 * The driver is `dialect-replay.ts`; what is written here is only the positions this file
 * needs. Each correction names its authority, and each exclusion would carry one reason
 * from the closed set of five — there is none, because every row of this file but one is
 * the catalog's own behaviour, which the engine reproduces.
 *
 * **Four rows of this file pin a conversion the catalog no longer declares.**
 * `string(timestamp)`, `string(duration)` and `int(timestamp)` are cel-spec's own, and the
 * LANGUAGE layer declares all three as of the engine's cel-spec work; a host
 * re-registering a spec signature under the same dispatch key would silently replace it,
 * so the catalog must not carry them. Three of the four rows (`catalog/string/duration`,
 * `catalog/string/duration_fraction`, `catalog/int/timestamp`) are answered identically by
 * the language layer and need no position at all. The fourth is corrected below, and at
 * the cutover all four move to the language file with the rest.
 */

import type { DialectCorrectionGroup, DialectExclusionGroup } from "./dialect-replay.js";

export const CATALOG_FILE = "catalog.json";

export const CATALOG_CORRECTIONS: readonly DialectCorrectionGroup[] = [
  {
    cause: "string(timestamp) writes RFC 3339 with no fractional part for a whole second",
    authority:
      "the row's expression is `string(timestamp('2009-02-13T23:31:30Z'))`, character for character the language row `timestamps/timestamp_conversions/toString_timestamp`, whose own `deviation.celSpec.value` is `2009-02-13T23:31:30Z` — what this engine answers and what the value-level language replay already corrects it to. The recorded `.000Z` is the engine being replaced holding an instant to milliseconds and always writing three of them; this conversion is the language's, not the catalog's, so the catalog does not redeclare it and the row moves to the language file at the cutover",
    rows: ["catalog/string/timestamp"],
  },
];

export const CATALOG_EXCLUSIONS: readonly DialectExclusionGroup[] = [];

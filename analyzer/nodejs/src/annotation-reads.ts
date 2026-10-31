/**
 * What every `x-telo-*` annotation reads beyond the node it is written on, as
 * one table over the whole vocabulary: each keyword maps to its own reader's
 * reporter (the reader knows its places; nothing here restates an annotation's
 * shape) or to {@link READS_NOTHING}. The table's type is exhaustive, so an
 * annotation added to the vocabulary without an entry here does not compile —
 * a read nobody reports would let a per-site verdict be reused where the place
 * it depends on differs.
 *
 * Browser-safe.
 */
import { X_TELO_TYPE } from "@telorun/sdk";
import { applicationSourceReads } from "./application-source-slot.js";
import { browserExportReads } from "./browser-export-slot.js";
import { returnsFromReads } from "./callable-signature.js";
import { catchesForReads, outcomeListReads } from "./catch-scope.js";
import { caughtMemberReads } from "./caught-member.js";
import { bindingsFromReads } from "./cel-bindings.js";
import { itemFillsReads } from "./context-fill-cycle.js";
import { fromReferrerReads } from "./context-from-referrer.js";
import { elementFromItemReads } from "./element-from-item.js";
import type { ReadReporter } from "./read-place.js";
import { refSlotReads } from "./ref-slot.js";
import { referrerRulesReads } from "./referrer-rule.js";
import { projectionFromReads } from "./schema-projection.js";
import { scopeReads } from "./scope-declarations.js";
import { catalogSetReads } from "./text-catalog-set.js";
import { textValuesForReads } from "./text-values.js";
import {
  contextCollectionReads,
  contextFromReads,
  contextFromRefKindReads,
  contextFromRootReads,
  contextParametersFromReads,
  contextReads,
  contextRefFromReads,
} from "./validate-cel-context.js";
import { matchForReads } from "./validate-match-for.js";
import { schemaFromReads, valueSchemaFromReads } from "./value-schema-slot.js";
import type { ANNOTATION_KEYWORDS } from "./value-type-keyword.js";
import { providesZoneReads, requiresZoneReads } from "./zone-slot.js";

/** An annotation whose meaning stays on the node it is written on. */
export const READS_NOTHING = "reads nothing" as const;

/** Every keyword of the annotation vocabulary. */
export type AnnotationKeyword = (typeof ANNOTATION_KEYWORDS)[number] | typeof X_TELO_TYPE;

export type AnnotationReadTable = {
  readonly [K in AnnotationKeyword]: ReadReporter | typeof READS_NOTHING;
};

export const ANNOTATION_READS: AnnotationReadTable = {
  "x-telo-application-source": applicationSourceReads,
  "x-telo-bindings-from": bindingsFromReads,
  "x-telo-browser-export": browserExportReads,
  "x-telo-catches-for": catchesForReads,
  "x-telo-caught-member": caughtMemberReads,
  "x-telo-context": contextReads,
  "x-telo-context-collection-from": contextCollectionReads,
  "x-telo-context-element-from": contextCollectionReads,
  "x-telo-context-element-from-item": elementFromItemReads,
  "x-telo-context-eval": READS_NOTHING,
  "x-telo-context-item-fills": itemFillsReads,
  "x-telo-context-from": contextFromReads,
  "x-telo-context-from-ref-kind": contextFromRefKindReads,
  "x-telo-context-from-referrer": fromReferrerReads,
  "x-telo-context-from-root": contextFromRootReads,
  "x-telo-context-parameters-from": contextParametersFromReads,
  "x-telo-context-ref-from": contextRefFromReads,
  "x-telo-error-context": READS_NOTHING,
  "x-telo-eval": READS_NOTHING,
  "x-telo-inline": READS_NOTHING,
  "x-telo-match-for": matchForReads,
  "x-telo-outcome-list": outcomeListReads,
  "x-telo-provides-zone": providesZoneReads,
  "x-telo-ref": refSlotReads,
  "x-telo-requires-zone": requiresZoneReads,
  // Judged by the `resourceRules` relation group, which declares what its rules read.
  "x-telo-resource-rules": READS_NOTHING,
  "x-telo-returns-from": returnsFromReads,
  "x-telo-schema-from": schemaFromReads,
  "x-telo-schema-map": READS_NOTHING,
  "x-telo-schema-projection": READS_NOTHING,
  "x-telo-schema-projection-from": projectionFromReads,
  "x-telo-scope": scopeReads,
  "x-telo-sensitive": READS_NOTHING,
  "x-telo-span-attribute": READS_NOTHING,
  "x-telo-step-context": READS_NOTHING,
  "x-telo-text-catalog-set": catalogSetReads,
  "x-telo-text-context": READS_NOTHING,
  "x-telo-text-values": READS_NOTHING,
  "x-telo-text-values-for": textValuesForReads,
  "x-telo-topology-role": READS_NOTHING,
  "x-telo-unbound-calls": READS_NOTHING,
  "x-telo-value-schema-from": valueSchemaFromReads,
  "x-telo-widget": READS_NOTHING,
  [X_TELO_TYPE]: READS_NOTHING,
};

/** The reporter of `keyword`, when it is an annotation that reads anything. */
export function readReporterOf(keyword: string): ReadReporter | undefined {
  const entry = (ANNOTATION_READS as Readonly<Record<string, ReadReporter | typeof READS_NOTHING>>)[keyword];
  return entry === undefined || entry === READS_NOTHING ? undefined : entry;
}

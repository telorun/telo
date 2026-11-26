/**
 * The families of finding a pass emits: one constant each, stamped on a
 * finding where its pass emits it. The stamp is provenance for tests only —
 * nothing is stamped unless a test observes it — so what an analysis returns
 * never carries one.
 *
 * Browser-safe.
 */
import type { AnalysisDiagnostic } from "./types.js";

/** The whole-application passes that carry conditions. */
export const UNION_PASS_FAMILIES = [
  "duplicateNames",
  "unusedDeclarations",
  "sinkAttachment",
  "observedStateDeclarations",
  "markReach",
  "scopedDuplicates",
  "scopedSinks",
  "cycles",
  "rethrowPlacement",
  "zoneRequirements",
  "zoneViolations",
  "durableRegions",
  "throwsCoverage",
  "resourceInputs",
  "optionalInputReferences",
  "templateBody",
  "templateForwards",
  "templateRelations",
  "needTable",
  "texts",
  "moduleDocuments",
  "kindDocuments",
  "scopedKindDocuments",
  "expansion",
  "importHostPaths",
] as const;

/** The document-level stages the passes of `moduleDocuments`, `kindDocuments`
 *  and `scopedKindDocuments` judge, each counted where it is evaluated. */
export const DOCUMENT_STAGES = [
  "requires",
  "libraryRequires",
  "nativeEntries",
  "sourceEntries",
  "applicationArguments",
  "inputDefaults",
  "inputCycles",
  "libraryInputCycles",
  "moduleArtifact",
  "hostPathDefaults",
  "kindHostPathDefaults",
  "logging",
  "moduleMetadata",
  "kindMetadata",
  "extends",
  "baseMapping",
  "providerCoherence",
  "schemaCompile",
  "schemaInPlaceCycle",
  "callableKinds",
  "controllerSelectors",
  "bodyReferenceForms",
  "libraryUntagged",
  "nestedStamps",
  "libraryNestedStamps",
  "importAliases",
  "libraryBlocks",
  "libraryBrowserExports",
  "libraryScopedKindDocuments",
  "libraryTextKeys",
  "scopedKindDocuments",
  "kindCapability",
  "kindRefSlots",
  "kindSlotAnnotations",
  "kindZoneSlots",
  "kindRules",
  "kindValueTypes",
  "kindAnnotations",
  "kindContracts",
] as const;

export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

/** The per-declaration stages judged once per key of a declaration's own
 *  region, each counted where it is evaluated. */
export const OWN_STAGES = [
  "kindSite",
  "referenceForms",
  "includePlacement",
  "untaggedInterpolation",
  "applicationInputs",
  "importInputs",
  "importAndSinkLogging",
  "callableInstances",
  "valueTypeSlots",
  "shapeRefSlots",
  "contractInputsForm",
  "textKeysPlacement",
] as const;

export type OwnStage = (typeof OWN_STAGES)[number];

/** The per-declaration relational stages judged at relation sites, once per
 *  relation key, each counted where it is evaluated. */
export const RELATION_STAGES = ["stepInvokes", "scopedNameReach", "namedShapeReferences"] as const;

export type RelationStage = (typeof RELATION_STAGES)[number];

/** Whether a relational group is one of {@link RELATION_STAGES}. */
export function isRelationStage(group: string): group is RelationStage {
  return (RELATION_STAGES as readonly string[]).includes(group);
}

/** The families judged per site rather than over the union. */
export const SITE_FAMILIES = ["references", "ruleAbsence", "presenceReads", "scopedNameReach", "namedShapeReferences"] as const;

/** The families a whole-application pass emits beside its own, stamped on the
 *  finding where it is rendered. */
export const NESTED_PASS_FAMILIES = ["durableContracts"] as const;

/** The families judged on the choices as written: a declaration-position
 *  choice's name, one entry of its namespace. */
export const CHOICE_FAMILIES = ["choiceNames"] as const;

/** The families a union-wide index decides, stamped by that index's reader on
 *  every finding whose wording it chooses: a kind spelled through an alias, worded
 *  by which of the module's scoped imports carrying the alias is present. */
export const INDEX_FAMILIES = ["scopedImportKinds"] as const;

export type UnionPassName = (typeof UNION_PASS_FAMILIES)[number];
export type AnalysisFamily =
  | UnionPassName
  | (typeof SITE_FAMILIES)[number]
  | (typeof NESTED_PASS_FAMILIES)[number]
  | (typeof CHOICE_FAMILIES)[number]
  | (typeof INDEX_FAMILIES)[number];

/** The families that judge a reference to something a configuration may omit,
 *  which a choice-free expansion cannot judge where it proves it present. */
export const PRESENCE_READ_FAMILIES: readonly AnalysisFamily[] = ["optionalInputReferences", "presenceReads"];

let observers = 0;

/** Stamp families on what is emitted until the returned function is called. */
export function observeFamilies(): () => void {
  observers++;
  return () => {
    observers--;
  };
}

/** `found` as `family` emitted it. */
export function inFamily<D extends AnalysisDiagnostic>(family: AnalysisFamily, found: readonly D[]): D[] {
  if (observers === 0) return found as D[];
  return found.map((d) => (familyOf(d) ? d : { ...d, data: { ...(d.data as object | undefined), family } }));
}

/** `diagnostic` as `family` emitted it. */
export function stampedIn<D extends AnalysisDiagnostic>(family: AnalysisFamily, diagnostic: D): D {
  return inFamily(family, [diagnostic])[0]!;
}

/** The family that emitted `diagnostic`, where one was observed. */
export function familyOf(diagnostic: AnalysisDiagnostic): AnalysisFamily | undefined {
  return (diagnostic.data as { family?: AnalysisFamily } | undefined)?.family;
}

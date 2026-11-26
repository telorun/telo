/**
 * The document-level stages over every configuration at once.
 *
 * A KIND document never varies (`assertInvariantKindDocuments`), so what its
 * stages find holds in every configuration and each is evaluated once.
 *
 * A MODULE document's stage reads some of its fields, each of which may hold a
 * choice, so it is judged once per class of the choices in the fields it reads:
 * the document projected to those fields is the stage's input, and what the
 * render asks of where it holds splits the finding by those choices alone
 * (`splitByReads`). A branch no configuration takes inside a field is read once
 * the same way. What a stage finds beside the document — an import's or a sink's —
 * is read by a later part and stays in the runs.
 *
 * A named shape is read as the classes of every instance of its module
 * (`NamedShapeReader.classes`), never one instance's: a document stage judges a
 * document once for every instance, so a shape of a library imported more than
 * once holds each instance's content where that instance reads it.
 *
 * Browser-safe.
 */
import { parseCanonicalTypeSchemaId, type ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DocumentStage } from "./analysis-families.js";
import { reportDocumentStage } from "./cel-site-judgements.js";
import type { ConditionedDeclaration, ConditionedExpansion } from "./conditioned-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { NamedShapeReader } from "./named-shape-reader.js";
import { schemaCompileFindings } from "./schema-compile-findings.js";
import { moduleInputCycleDiagnostics, schemaInPlaceCycleFindings } from "./schema-in-place-cycle-findings.js";
import { kindAnnotationFindings } from "./kind-annotation-findings.js";
import { kindContractFindings } from "./kind-contract-findings.js";
import { libraryBrowserExportFindings, libraryTextKeyPlacementFindings } from "./library-document-findings.js";
import { holdsChoice } from "./key-door.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import type { ModuleDocuments } from "./module-documents.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import type { ImportReach } from "./reaching-import.js";
import { reachedLibraryDocuments } from "./requires-gate.js";
import { libraryBlockDiagnostics } from "./validate-library-blocks.js";
import { validateLibraryScopedKindDocuments, type KindDocumentKind } from "./validate-scoped-kind-documents.js";
import type { SchemaValidationOutcome } from "./schema-validation.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type DeadFinding, type PassTable, type ReadFinding } from "./union-passes.js";
import { validateApplicationArguments } from "./validate-application-arguments.js";
import { validateBaseMapping } from "./validate-base-mapping.js";
import { validateCallableKindDocuments } from "./validate-callable-kinds.js";
import { validateExtends } from "./validate-extends.js";
import { validateKindHostPathDefaults, validateLibraryHostPathDefaults } from "./validate-host-path-defaults.js";
import { canonicalInModule, validateInputDefaults, type InputDefaultsScope } from "./validate-input-defaults.js";
import { validateModuleDocumentLogging } from "./validate-logging.js";
import { validateControllerSelectorDocuments, validateModuleDocumentArtifact } from "./validate-module-artifact.js";
import { validateKindDocumentMetadata, validateModuleDocumentMetadata } from "./validate-module-metadata.js";
import { validateNativeEntries } from "./validate-native-entries.js";
import { validateProviderCoherence } from "./validate-provider-coherence.js";
import { validateTemplateBodyReferenceForms } from "./validate-reference-forms.js";
import { validateRequires, type ValidateRequiresOptions } from "./validate-requires.js";
import { untaggedInterpolationInLibraries } from "./untagged-interpolation.js";
import { validateSourceEntries } from "./validate-source-entries.js";
import type { DeadBranchRun, WorldReader } from "./world-reader.js";

const SOURCE = "telo-analyzer";

/** What the kind-document stages read. */
export interface KindDocumentScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The named shapes, as the analysis reads them. */
  readonly shapes: NamedShapeReader;
  /** Which of the entry's imports reaches each library. */
  readonly reach: ImportReach;
  /** Each imported library's own documents. */
  readonly moduleDocuments: readonly ModuleDocuments[];
}

/** One kind-document stage: its name and what it finds in `kinds` — each
 *  finding in every configuration, or, `read`, where it holds. */
export type KindStage =
  | { readonly name: DocumentStage; run(kinds: readonly ResourceManifest[], scope: KindDocumentScope): AnalysisDiagnostic[] }
  | { readonly name: DocumentStage; read(kinds: readonly ResourceManifest[], scope: KindDocumentScope): ReadFinding[] };

/** The stages of the kind documents, in the order a plain analysis runs them. */
export const KIND_STAGES: readonly KindStage[] = [
  { name: "kindHostPathDefaults", run: (kinds, { rootModules }) => validateKindHostPathDefaults(kinds, rootModules) },
  { name: "controllerSelectors", run: (kinds) => validateControllerSelectorDocuments(kinds) },
  {
    name: "schemaCompile",
    read: (kinds, { defs, aliases, aliasesByModule, rootModules, shapes }) =>
      schemaCompileFindings(kinds, shapes, { defs, aliases, aliasesByModule, rootModules: new Set(rootModules) }),
  },
  { name: "schemaInPlaceCycle", read: (kinds, scope) => schemaInPlaceCycleFindings(kinds, scope) },
  { name: "extends", run: (kinds, { defs, aliases, rootModules }) => validateExtends([...kinds], defs, aliases, rootModules) },
  { name: "baseMapping", run: (kinds, { defs, aliases, rootModules }) => validateBaseMapping([...kinds], defs, aliases, rootModules) },
  { name: "providerCoherence", run: (kinds, { defs, aliases, rootModules }) => validateProviderCoherence([...kinds], defs, aliases, rootModules) },
  {
    name: "bodyReferenceForms",
    run: (kinds, { defs, aliases, aliasesByModule }) => validateTemplateBodyReferenceForms([...kinds], defs, aliases, aliasesByModule),
  },
  { name: "kindMetadata", run: (kinds, { defs, aliases, rootModules }) => validateKindDocumentMetadata(kinds, defs, aliases, rootModules) },
  { name: "kindAnnotations", read: (kinds, scope) => kindAnnotationFindings(kinds, scope) },
  { name: "kindContracts", read: (kinds, scope) => kindContractFindings(kinds, scope) },
  {
    name: "callableKinds",
    run: (kinds, { defs, aliases, aliasesByModule, rootModules }) =>
      validateCallableKindDocuments(kinds, defs, aliases, aliasesByModule, rootModules),
  },
];

/** What every kind document of `kinds` finds, each stage evaluated once, each
 *  finding holding in every configuration. */
export function kindDocumentFindings(
  kinds: readonly ResourceManifest[],
  scope: KindDocumentScope,
  /** What the registration loop found in them, judged once by the registration run. */
  registered: readonly AnalysisDiagnostic[] = [],
): PassTable {
  const found: ReadFinding[] = [];
  for (const stage of KIND_STAGES) {
    reportDocumentStage(stage.name, false);
    if ("read" in stage) found.push(...stage.read(kinds, scope));
    else for (const diagnostic of stage.run(kinds, scope)) found.push({ held: TRUE, render: () => [diagnostic] });
  }
  for (const diagnostic of registered) found.push({ held: TRUE, render: () => [diagnostic] });
  return { found, dead: [] };
}

/** The union's kind-declaring documents as every configuration's run holds them. */
export function kindDocumentsOf(union: ConditionedExpansion, asRunHolds: (declaration: ConditionedDeclaration) => ResourceManifest): ResourceManifest[] {
  return union.declarations
    .filter((d) => d.condition !== FALSE && !d.unreachable && isKindDocument(d.manifest))
    .map(asRunHolds);
}

/** Each named shape by canonical id as the configurations `read` reads take
 *  it, canonical in the module declaring it. */
export function inputShapeLookup(
  shapes: NamedShapeReader,
  read: WorldReader<Condition>,
  scope: InputDefaultsScope,
): (id: string) => Record<string, any> | undefined {
  const known = new Map<string, Record<string, any> | undefined>();
  return (id) => {
    if (known.has(id)) return known.get(id);
    const named = parseCanonicalTypeSchemaId(id);
    const taken = named ? shapes.classAt(id, read) : undefined;
    const schema = taken && named ? canonicalInModule(taken.schema, named.moduleName, scope) : undefined;
    known.set(id, schema);
    return schema;
  };
}

/** One stage of a module document: the fields it reads, and what it finds in
 *  the document projected to them. */
interface ModuleStage {
  readonly name: DocumentStage;
  readonly fields: readonly string[];
  run(documents: ResourceManifest[], read: WorldReader<Condition>): AnalysisDiagnostic[];
}

export interface ModuleDocumentInputs {
  readonly union: ConditionedExpansion;
  readonly rootModules: ReadonlySet<string>;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  /** The kind documents of the union, as a run holds them: what a source's
   *  staged controller path is claimed by. */
  readonly kindDocuments: readonly ResourceManifest[];
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** The named shapes, by class, an entry's references read. */
  readonly shapes: NamedShapeReader;
  readonly hostVersions: ValidateRequiresOptions["hostVersions"];
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
  /** What the registration found repeated in a module scope's aliases. */
  readonly duplicateAliases: readonly AnalysisDiagnostic[];
  /** Which of the entry's imports reaches each library. */
  readonly reach: ImportReach;
  /** A scope member's kind document held against its built-in entry. */
  readonly validateScopedKind: (member: ResourceManifest, kind: KindDocumentKind) => SchemaValidationOutcome;
}

/**
 * What the module documents find, each stage once per class of the choices in
 * the fields it reads — a document with no choice there is one class — and
 * once in each branch no configuration takes inside those fields. The gate of
 * an imported library, which no choice varies, is judged once.
 */
export function moduleDocumentFindings(inputs: ModuleDocumentInputs): PassTable {
  const { union, rootModules, defs, aliases } = inputs;
  const requires: ValidateRequiresOptions = { hostVersions: inputs.hostVersions, entryModules: rootModules };
  const inputScope = { aliases, aliasesByModule: inputs.aliasesByModule, rootModules };
  const stages: readonly ModuleStage[] = [
    { name: "requires", fields: ["requires", "restrictions"], run: (docs) => validateRequires(docs, requires) },
    { name: "nativeEntries", fields: ["native"], run: (docs) => validateNativeEntries(docs, rootModules) },
    {
      name: "sourceEntries",
      fields: ["sources", "native", "assets"],
      run: (docs) => validateSourceEntries([...docs, ...inputs.kindDocuments], rootModules),
    },
    { name: "applicationArguments", fields: ["variables", "secrets", "ports"], run: (docs) => validateApplicationArguments(docs, rootModules) },
    {
      name: "inputDefaults",
      fields: ["variables", "secrets"],
      run: (docs, read) => validateInputDefaults(docs, inputScope, inputShapeLookup(inputs.shapes, read, inputScope)),
    },
    { name: "inputCycles", fields: ["variables", "secrets"], run: (docs) => moduleInputCycleDiagnostics(docs, rootModules, inputs.reach) },
    { name: "moduleArtifact", fields: ["layers", "exports"], run: (docs) => validateModuleDocumentArtifact(docs) },
    { name: "hostPathDefaults", fields: ["variables", "secrets"], run: (docs) => validateLibraryHostPathDefaults(docs, rootModules) },
    { name: "logging", fields: ["logging", "imports"], run: (docs) => validateModuleDocumentLogging(docs) },
    { name: "moduleMetadata", fields: [], run: (docs) => validateModuleDocumentMetadata(docs, defs, aliases) },
    { name: "libraryBlocks", fields: ["variables", "secrets", "exports"], run: (docs) => libraryBlockDiagnostics(docs) },
  ];
  const documents = union.declarations.filter((d) => d.condition !== FALSE && !d.unreachable && isModuleKind(d.manifest.kind));
  /** `declaration` projected to `stage`'s fields as `read` decides each choice
   *  in them. */
  const viewOf = (declaration: ConditionedDeclaration, stage: ModuleStage, read: { taken: (e: any) => boolean }): ResourceManifest => {
    const picked: Record<string, unknown> = { kind: declaration.manifest.kind, metadata: declaration.manifest.metadata };
    for (const field of stage.fields) if (field in declaration.manifest) picked[field] = (declaration.manifest as Record<string, unknown>)[field];
    return union.projectBy(picked, read).value as ResourceManifest;
  };
  const found: ReadFinding[] = [];
  // An alias repeated in one module scope is judged where the registration
  // registers aliases, once; imports never vary.
  reportDocumentStage("importAliases", false);
  for (const diagnostic of inputs.duplicateAliases) found.push({ held: TRUE, render: () => [diagnostic] });
  const deadReads = new Map<DeadBranchRun, DeadFinding[]>();
  for (const declaration of documents) {
    for (const stage of stages) {
      found.push({
        held: declaration.condition,
        render: (read: WorldReader<unknown>) => {
          reportDocumentStage(stage.name, false);
          return stage.run([viewOf(declaration, stage, read)], read);
        },
      });
      const varies = stage.fields.some((field) => holdsChoice((declaration.manifest as Record<string, unknown>)[field]));
      if (!varies) continue;
      for (const branch of inputs.deadBranches) {
        const list = deadReads.get(branch) ?? [];
        deadReads.set(branch, list);
        list.push({
          branch,
          render: (read) => {
            if (!read.taken(declaration)) return [];
            reportDocumentStage(stage.name, false);
            // What lies outside the branch reads as the configuration reaching it.
            const atBaseline: WorldReader<Condition> = {
              holds: (condition) => union.space.holds(condition, branch.baseline),
              taken: read.taken,
            };
            return stage.run([viewOf(declaration, stage, read)], atBaseline);
          },
        });
      }
    }
  }
  const libraries = reachedLibraryDocuments(
    union.declarations.map((d) => d.manifest),
    inputs.moduleDocuments,
  );
  if (libraries.length > 0) {
    reportDocumentStage("libraryRequires", false);
    for (const diagnostic of validateRequires(libraries, requires)) found.push({ held: TRUE, render: () => [diagnostic] });
    reportDocumentStage("libraryInputCycles", false);
    for (const diagnostic of moduleInputCycleDiagnostics(libraries, rootModules, inputs.reach, true)) {
      found.push({ held: TRUE, render: () => [diagnostic] });
    }
  }
  // What an imported library holds is read outside every configuration, at
  // the imports that reach it.
  if (inputs.moduleDocuments.length > 0) {
    reportDocumentStage("libraryUntagged", false);
    const imports = union.declarations.filter((d) => d.condition !== FALSE && !d.unreachable).map((d) => d.manifest);
    for (const diagnostic of untaggedInterpolationInLibraries(imports, rootModules, inputs.moduleDocuments)) {
      found.push({ held: TRUE, render: () => [diagnostic] });
    }
    // The same objects the nested-stamp judge reads, once per library, each
    // finding at the first import reaching it.
    const place = (diagnostics: readonly AnalysisDiagnostic[]) => {
      for (const diagnostic of diagnostics) found.push({ held: TRUE, render: () => [diagnostic] });
    };
    reportDocumentStage("libraryScopedKindDocuments", false);
    place(
      validateLibraryScopedKindDocuments(inputs.moduleDocuments, defs, aliases, inputs.aliasesByModule, rootModules, inputs.reach, inputs.validateScopedKind),
    );
    const libraryScope = { libraries: inputs.moduleDocuments, defs, aliases, aliasesByModule: inputs.aliasesByModule, rootModules, reach: inputs.reach };
    reportDocumentStage("libraryBrowserExports", false);
    place(libraryBrowserExportFindings(libraryScope, inputs.kindDocuments));
    // A text-keys annotation outside a kind's `schema:`, on a document the
    // kernel creates: every document of a library.
    reportDocumentStage("libraryTextKeys", false);
    place(libraryTextKeyPlacementFindings(inputs.moduleDocuments, inputs.reach));
  }
  return {
    found,
    dead: readDeadBranches("moduleDocuments", inputs.deadBranches, (branch) => deadReads.get(branch) ?? []),
  };
}

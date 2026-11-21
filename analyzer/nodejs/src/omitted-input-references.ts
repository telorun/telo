/**
 * A dependency's reference to an optional resource input an import of it
 * omits (`RESOURCE_INPUT_OPTIONAL_REFERENCED`), as a condition.
 *
 * A library's references are read once over its own configurations — its
 * union, its call graph — each held under a condition in the library's own
 * space. An import carries each into its importer's space through what the
 * import says of the library's dimensions: an input it omits is absent and one
 * it supplies present, a variable or secret it binds to a literal is that
 * literal; every other dimension decides nothing and is projected out. No
 * configuration of the library is enumerated.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import { isExpansionSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { AnalysisRegistry } from "./analysis-registry.js";
import { conditionedCallGraph } from "./conditioned-call-graph.js";
import { ConditionedNameIndex } from "./conditioned-name-index.js";
import { expandUnion, type ChoiceDecider } from "./conditioned-expansion.js";
import { isStandInDeclaration } from "./choice-expansion.js";
import { readChoices } from "./choice-reading.js";
import { choiceScopeOf } from "./choice-scope.js";
import { ABSENT, PRESENT, type Dimension } from "./configuration-dimensions.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ModuleDocuments } from "./module-documents.js";
import { optionalInputReferenceMessage, type OptionalInputReference } from "./optional-input-references.js";
import { writtenPlaceOf, type WrittenAt } from "./diagnostic-identity.js";
import { FALSE, TRUE, ConditionSpace, type Condition, type TranslationMeaning } from "./presence-condition.js";
import { importAnchoredDiagnostic, importReach } from "./reaching-import.js";
import { readSuppliedResources } from "./resource-input.js";
import {
  edgeReferenceAt,
  edgeReferenceFinding,
  forwardedOptionalInputs,
  forwardedReferenceFinding,
  optionalInputEdgeReferences,
} from "./resource-input-findings.js";
import type { AnalysisDiagnostic } from "./types.js";
import { unionWorld, type UnionWorld } from "./union-placement.js";
import type { ReadFinding } from "./union-passes.js";
import type { WorldReader } from "./world-reader.js";

/** One reference of a library to an optional input, and where it holds in the
 *  library's own space. */
interface LibraryReference {
  readonly input: string;
  readonly condition: Condition;
  /** The reference as `read` decides the choices naming and placing its
   *  holder. */
  at(read: ChoiceDecider): OptionalInputReference;
  /** Where the library's own check reports it, as `read` decides the choices:
   *  its finding placed as the library's own placement places it. */
  writtenAt(read: ChoiceDecider): WrittenAt;
}

/** What a library's own configurations hold of references to its optional inputs. */
export interface LibraryReferences {
  readonly space: ConditionSpace;
  readonly dimensions: readonly Dimension[];
  readonly references: readonly LibraryReference[];
}

/** What reading a library needs of the analysis around it. */
export interface LibraryScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly scopeFieldsOf: (holder: ResourceManifest) => readonly string[];
  readonly documents: readonly ModuleDocuments[];
  /** The importer's documents the library's choices are scoped by. */
  readonly importer: readonly ResourceManifest[];
  /** The registry's view of the library's own module. */
  readonly view: AnalysisRegistry;
}

/** Every reference `target` makes to an optional resource input, each with the
 *  library configurations it holds in. */
export function libraryOptionalReferences(target: ModuleDocuments, scope: LibraryScope): LibraryReferences {
  const sentinels = target.manifests.filter(isExpansionSentinel);
  const declarations = target.manifests.filter((m) => !sentinels.includes(m));
  const choices = readChoices(declarations, sentinels, choiceScopeOf(declarations, scope.view, scope.importer));
  const space = new ConditionSpace(choices.dimensions);
  const union = expandUnion(target.manifests, space, choices.branchConditions(space), undefined, true, choices.unreachable);
  const graph = conditionedCallGraph({
    union,
    names: new ConditionedNameIndex(union),
    defs: scope.defs,
    aliases: scope.aliases,
    aliasesByModule: scope.aliasesByModule,
    scopeFieldsOf: scope.scopeFieldsOf,
    withShapes: (build) => build(),
    libraries: scope.documents,
  });
  const reaches = (): Condition => TRUE;
  let world: UnionWorld | undefined;
  const placed = (finding: AnalysisDiagnostic, read: ChoiceDecider): WrittenAt =>
    writtenPlaceOf((world ??= unionWorld(union, graph)).placement.place([finding], read)[0]!);
  const references: LibraryReference[] = [
    ...optionalInputEdgeReferences(graph, reaches)
      .filter((reference) => !isStandInDeclaration(reference.edge.declaration.manifest))
      .map((reference) => ({
      input: reference.input,
      condition: reference.condition,
      at: (read: ChoiceDecider) => edgeReferenceAt(graph, reference, read),
      writtenAt: (read: ChoiceDecider) => placed(edgeReferenceFinding(graph, reference, read), read),
    })),
    ...forwardedOptionalInputs(union, reaches).map(({ reference, condition }) => ({
      input: reference.input,
      condition,
      at: () => reference,
      writtenAt: (read: ChoiceDecider) => placed(forwardedReferenceFinding(reference), read),
    })),
  ];
  return { space, dimensions: choices.dimensions, references };
}

/** What a reading of the importer's reads of an import's library needs. */
export interface ImportScope {
  /** The importer's own space: the analysis's, or a choice-free one. */
  readonly space: ConditionSpace;
  readonly rootModules: ReadonlySet<string>;
  /** The importer's documents, which tell how an import is reached. */
  readonly manifests: readonly ResourceManifest[];
  library(target: ModuleDocuments): LibraryReferences;
}

/**
 * What each import of `manifests` that leaves an optional input of its library
 * out is refused with, at the entry's import reaching it, and where it holds in
 * the importer's space.
 */
export function omittedInputFindings(manifests: readonly ResourceManifest[], documents: readonly ModuleDocuments[], scope: ImportScope): ReadFinding[] {
  const { space } = scope;
  const out: ReadFinding[] = [];
  let reach: ReturnType<typeof importReach> | undefined;
  for (const imp of manifests) {
    if (imp.kind !== "Telo.Import") continue;
    const meta = imp.metadata as {
      name?: string;
      module?: string;
      source?: string;
      resolvedModuleName?: string;
      optionalResources?: readonly string[];
    };
    if (!meta.name || !meta.resolvedModuleName || !meta.optionalResources?.length) continue;
    const supplied = readSuppliedResources(imp);
    const omitted = new Set(meta.optionalResources.filter((name) => !Object.hasOwn(supplied, name)));
    if (omitted.size === 0) continue;
    const target = documents.find((d) => d.module === meta.resolvedModuleName);
    if (!target) continue;
    const library = scope.library(target);
    const meaningOf = (key: string): TranslationMeaning | undefined => {
      const dimension = library.dimensions.find((d) => d.key === key)!;
      if (dimension.input === "resources") {
        const input = dimension.needPath?.length === 1 ? dimension.needPath[0]! : undefined;
        if (input === undefined || !meta.optionalResources!.includes(input)) return undefined;
        return { fact: omitted.has(input) ? ABSENT : PRESENT };
      }
      if (dimension.projection !== "whole") return undefined;
      const written = (imp as Record<string, any>)[dimension.input]?.[dimension.name];
      if (written === undefined || isTaggedSentinel(written) || isCompiledValue(written)) return undefined;
      return { fact: written };
    };
    const carry = (condition: Condition): Condition => library.space.translate(condition, space, meaningOf);
    const held = library.references
      .filter((reference) => omitted.has(reference.input))
      .map((reference) => ({ reference, condition: carry(reference.condition) }))
      .filter(({ condition }) => condition !== FALSE);
    if (held.length === 0) continue;
    const own = meta.module === undefined || scope.rootModules.has(meta.module);
    const via = own ? undefined : (reach ??= importReach([...manifests], scope.rootModules)).of(meta.module!);
    if (!own && !via) continue;
    out.push({
      held: space.some(held.map((each) => each.condition)),
      render: (read: WorldReader<Condition>) => {
        const inLibrary: ChoiceDecider = { taken: (element) => read.holds(carry(element.condition)) };
        const refusals = new Map<string, LibraryReference>();
        for (const { reference, condition } of held) {
          if (!read.holds(condition)) continue;
          const message = optionalInputReferenceMessage(reference.at(inLibrary));
          if (!refusals.has(message)) refusals.set(message, reference);
        }
        if (refusals.size === 0) return [];
        const message = [...refusals.keys()].join(" ");
        // The first reference is where the library's own check reports it, each
        // choice on the way to it decided where the reference holds.
        const first = [...refusals.values()][0]!;
        const written = first.writtenAt({
          taken: (element) => read.holds(carry(library.space.and(element.condition, first.condition))),
        });
        return [
          own
            ? importAnchoredDiagnostic(
                "RESOURCE_INPUT_OPTIONAL_REFERENCED",
                target.module,
                { alias: meta.name!, ...(meta.source ? { filePath: meta.source } : {}), path: `imports.${meta.name}` },
                message,
                written,
              )
            : importAnchoredDiagnostic("RESOURCE_INPUT_OPTIONAL_REFERENCED", target.module, via!, message, written),
        ] as AnalysisDiagnostic[];
      },
    });
  }
  return out;
}

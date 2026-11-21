/**
 * The resource-input checks over every configuration at once: what an import
 * hands a library (`RESOURCE_INPUT_*`), two imports of one shared library
 * disagreeing (`SHARED_LIBRARY_*`), and a reference to an optional resource
 * input where it may be absent (`RESOURCE_INPUT_OPTIONAL_REFERENCED`).
 *
 * An import never varies — a choice is refused in a module document's
 * `imports:` — so what varies is what each name it supplies resolves to. Each
 * supplied entry is judged once per outcome of the lookups its reference
 * makes, with the import normalized at a witness of that outcome; every other
 * finding of the import is judged once. A reference to an optional input is a
 * call-graph edge reaching it, held where the edge reaches it and the input is
 * not proven present.
 *
 * Each table lists its findings in the order the plain passes report them,
 * each with where it holds.
 *
 * Browser-safe.
 */
import { aboutDeclaration } from "./placement.js";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { ResourceGraphNode } from "./call-graph.js";
import type { ConditionedCallGraph, HeldGraphEdge } from "./conditioned-call-graph.js";
import { takenAt, World, type ChoiceDecider, type ConditionedDeclaration, type ConditionedExpansion } from "./conditioned-expansion.js";
import type { ConditionedNameIndex, ConditionedOutcome } from "./conditioned-name-index.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import type { Assignment } from "./configuration-dimensions.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { KeyParts } from "./key-parts.js";
import type { ModuleDocuments } from "./module-documents.js";
import { optionalInputReferenceMessage } from "./optional-input-references.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { declarationOf } from "./reference-resolution.js";
import { isOptionalResourceInput, readSuppliedResources } from "./resource-input.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { fixedFindings, fixedPassTable, readDeadBranches, type PassFinding, type PassTable, type ReadFinding } from "./union-passes.js";
import {
  importInputDiagnostics,
  resourceInputDeclarationDiagnostics,
  sharedKeyConflict,
  sharedKeysOf,
  sharedLibraryPairs,
  suppliedConfigOf,
  SUPPLIED_BLOCKS,
  type ImportInputScope,
} from "./validate-resource-inputs.js";
import type { DeadBranchRun, WorldReader } from "./world-reader.js";

const moduleOf = (m: ResourceManifest): string | undefined => (m.metadata as { module?: string } | undefined)?.module;

const present = (d: ConditionedDeclaration): boolean => d.condition !== FALSE && !d.unreachable;

/** One class of configurations a supplied entry is judged in, and a witness of it. */
interface Alternative {
  readonly condition: Condition;
  readonly witness: World;
}

export interface ResourceInputFindingsInputs {
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  readonly parts: KeyParts;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly rootModules: ReadonlySet<string>;
  readonly acceptsKind: ImportInputScope["acceptsKind"];
  readonly documents: readonly ModuleDocuments[];
  /** A configuration every finding no choice decides is judged at. */
  readonly base: World;
  /** The configurations kept: a witness is one of them. */
  readonly universe: Condition;
}

/**
 * `RESOURCE_INPUT_*` and `SHARED_LIBRARY_*` over every configuration: the
 * library's own declaration once, each import's fixed findings once, and each
 * supplied entry — and each resource input two shared imports compare — once
 * per class of the outcomes of the lookups its references make.
 */
export function resourceInputFindings(inputs: ResourceInputFindingsInputs): PassTable {
  const { union, names, parts, base } = inputs;
  const { space } = union;
  const isOwn = (module: string | undefined): boolean => !module || inputs.rootModules.has(module);
  const scopeAt = (witness: World): ImportInputScope => ({
    aliases: inputs.aliases,
    acceptsKind: inputs.acceptsKind,
    isOwn,
    suppliedDeclaration: (name, module) => declarationOf(names.locateAt("local", name, module, undefined, witness).outcome),
  });
  const normalizedAt = (declaration: ConditionedDeclaration, witness: World): ResourceManifest => {
    reportKeyCost({ kind: "pass-reading", pass: "resourceInputs", declaration });
    return parts.partAt(declaration, witness).manifests[0]!;
  };
  /** The import with the one entry at `key`, normalized at `witness` on its own. */
  const entryAt = (declaration: ConditionedDeclaration, key: string, witness: World): ResourceManifest => {
    reportKeyCost({ kind: "pass-reading", pass: "resourceInputs", declaration });
    return parts.regionAt(declaration, ["resources", key], witness).manifests[0]!;
  };
  const declarations = union.declarations.filter(present);
  const imports = declarations.filter((d) => d.manifest.kind === "Telo.Import");

  /** The classes the entry at `key` of `declaration` is judged in: one per
   *  combination of the outcomes of every lookup its reference makes. */
  const alternativesOf = (declaration: ConditionedDeclaration, key: string): Alternative[] => {
    const target = refSentinelTarget(readSuppliedResources(declaration.manifest)[key]);
    if (!target) return [{ condition: space.and(declaration.condition, inputs.universe), witness: base }];
    const named = new Set([target.name, ...(target.alias ? [target.alias] : [])]);
    const lists: ConditionedOutcome[][] = [names.locate("local", target.name, moduleOf(declaration.manifest))];
    for (const lookup of parts.partAt(declaration, base).lookups) {
      if (!named.has(lookup.name)) continue;
      lists.push(
        lookup.locate
          ? names.locate(lookup.population, lookup.name, lookup.locate.fromModule, lookup.locate.within)
          : names.inModule(lookup.population, lookup.name, lookup.inModule!.module, lookup.inModule!.importPath),
      );
    }
    return classesOf(space, space.and(declaration.condition, inputs.universe), lists);
  };

  const findings: PassFinding[] = [];
  for (const diagnostic of resourceInputDeclarationDiagnostics(
    declarations.map((d) => d.manifest),
    inputs.defs,
    inputs.aliases,
    isOwn,
  )) {
    findings.push({ diagnostic, condition: TRUE });
  }

  const alternatives = new Map<ConditionedDeclaration, Map<string, Alternative[]>>();
  const entryAlternatives = (declaration: ConditionedDeclaration, key: string): Alternative[] => {
    let byKey = alternatives.get(declaration);
    if (!byKey) alternatives.set(declaration, (byKey = new Map()));
    let known = byKey.get(key);
    if (!known) byKey.set(key, (known = alternativesOf(declaration, key)));
    return known;
  };

  for (const declaration of imports) {
    const entries = Object.keys(readSuppliedResources(declaration.manifest));
    const entryPaths = new Set(entries.map((key) => `resources.${key}`));
    const pathOf = (d: AnalysisDiagnostic) => (d.data as { path?: unknown } | undefined)?.path;
    for (const diagnostic of importInputDiagnostics(normalizedAt(declaration, base), scopeAt(base))) {
      if (!entryPaths.has(String(pathOf(diagnostic)))) findings.push({ diagnostic, condition: declaration.condition });
    }
    for (const key of entries) {
      for (const { condition, witness } of entryAlternatives(declaration, key)) {
        for (const diagnostic of importInputDiagnostics(entryAt(declaration, key, witness), scopeAt(witness), key)) {
          findings.push({ diagnostic, condition });
        }
      }
    }
  }

  const byBase = new Map(imports.map((d) => [normalizedAt(d, base), d] as const));
  for (const pair of sharedLibraryPairs([...byBase.keys()], inputs.documents)) {
    const [first, later] = pair.imports.map((m) => byBase.get(m)!);
    const held = space.and(first!.condition, later!.condition);
    for (const block of SUPPLIED_BLOCKS) {
      for (const key of sharedKeysOf(pair, block)) {
        if (block !== "resources") {
          const diagnostic = sharedKeyConflict(pair, block, key, isOwn);
          if (diagnostic) findings.push({ diagnostic, condition: held });
          continue;
        }
        // The two entries' values, each as its own lookups resolve it.
        const sides = [first!, later!].map((d) =>
          Object.hasOwn(readSuppliedResources(d.manifest), key)
            ? entryAlternatives(d, key)
            : [{ condition: space.and(d.condition, inputs.universe), witness: base }],
        );
        for (const a of sides[0]!) {
          for (const b of sides[1]!) {
            const condition = space.and(a.condition, b.condition);
            if (condition === FALSE) continue;
            const witness: World = World.key(space.firstAssignment(condition) as Assignment);
            const at = [first!, later!].map(
              (d) =>
                suppliedConfigOf(
                  Object.hasOwn(readSuppliedResources(d.manifest), key) ? entryAt(d, key, witness) : normalizedAt(d, base),
                  inputs.documents,
                )!,
            );
            const diagnostic = sharedKeyConflict({ first: at[0]!, later: at[1]! }, block, key, isOwn);
            if (diagnostic) findings.push({ diagnostic, condition });
          }
        }
      }
    }
  }
  return fixedPassTable(findings);
}

/** Every non-empty class of `within` the outcome lists split it into, each
 *  with a witness: their product, a condition holding in no configuration
 *  left out. */
function classesOf(space: ConditionSpace, within: Condition, lists: readonly ConditionedOutcome[][]): Alternative[] {
  let classes: Condition[] = [within];
  for (const list of lists) {
    const next: Condition[] = [];
    for (const held of classes) {
      for (const { condition } of list) {
        const both = space.and(held, condition);
        if (both !== FALSE && !next.includes(both)) next.push(both);
      }
    }
    classes = next;
  }
  return classes.map((condition) => ({ condition, witness: World.key(space.firstAssignment(condition) as Assignment) }));
}

export interface OptionalInputReferenceInputs {
  readonly graph: ConditionedCallGraph;
  readonly union: ConditionedExpansion;
  readonly rootModules: ReadonlySet<string>;
  /** Where some configuration proves the resource input `input` present. */
  readonly present: (input: string) => Condition;
  /** A dependency's references to an input an import omits, at the entry's
   *  import reaching it, with where each holds. */
  readonly omitted: readonly ReadFinding[];
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** A reference from a call-graph edge to an optional resource input. */
export interface EdgeReference {
  readonly edge: HeldGraphEdge;
  /** The resource node holding the reference. */
  readonly holder: string;
  readonly target: string;
  readonly input: string;
  /** Where the input may be absent. */
  readonly absent: Condition;
  readonly condition: Condition;
}

/**
 * `RESOURCE_INPUT_OPTIONAL_REFERENCED` over every configuration: each call
 * graph edge reaching an optional resource input of the entry's own modules,
 * where it reaches it and the input is not proven present; each import
 * forwarding one, likewise; then each dependency's reference to an input an
 * import omits.
 */
export function optionalInputReferenceFindings(inputs: OptionalInputReferenceInputs): PassTable {
  const { graph, union, rootModules } = inputs;
  const { space } = union;
  const absentOf = (manifest: ResourceManifest, input: string): Condition => {
    const module = moduleOf(manifest);
    return module === undefined || rootModules.has(module) ? space.not(inputs.present(input)) : FALSE;
  };
  const references = optionalInputEdgeReferences(graph, absentOf);
  const forwards: PassFinding[] = forwardedOptionalInputs(union, absentOf).map(({ reference, condition }) => ({
    diagnostic: forwardedReferenceFinding(reference),
    condition,
  }));

  const render = (reference: EdgeReference, read: ChoiceDecider): AnalysisDiagnostic[] => [edgeReferenceFinding(graph, reference, read)];

  const fixed = forwards;
  const deadReader = (branch: DeadBranchRun): WorldReader<Condition> => ({
    holds: (condition) => space.holds(condition, branch.baseline),
    taken: (element) => takenAt(space, element.condition, element.path, branch.baseline, branch.world.forcing),
  });
  return {
    found: [
      ...references.map((reference) => ({ held: reference.condition, render: (read: ChoiceDecider) => render(reference, read) })),
      ...fixedFindings(fixed),
      ...inputs.omitted,
    ],
    dead: readDeadBranches("optionalInputReferences", inputs.deadBranches, (branch) => {
      const witness: World = branch.world;
      return [
        ...references
          .filter(
            (reference) =>
              graph.targetAt(reference.edge, witness)?.to === reference.target && space.holds(reference.absent, branch.baseline),
          )
          .map((reference) => ({ branch, render: (read: ChoiceDecider) => render(reference, read) })),
        ...fixed
          .filter(({ condition }) => space.holds(condition, branch.baseline))
          .map(({ diagnostic }) => ({ branch, render: () => [diagnostic] })),
        ...inputs.omitted
          .filter(({ held }) => space.holds(held, branch.baseline))
          .map((finding) => ({ branch, render: () => [...finding.render(deadReader(branch))] })),
      ];
    }),
  };
}

/** Each call graph edge reaching an optional resource input, held where it
 *  reaches it and `absentOf` says the input may be absent. */
export function optionalInputEdgeReferences(
  graph: ConditionedCallGraph,
  absentOf: (manifest: ResourceManifest, input: string) => Condition,
): EdgeReference[] {
  const space = graph.space;
  const references: EdgeReference[] = [];
  for (const edge of graph.edgesInRunOrder()) {
    if (edge.edge.moduleCall) continue;
    for (const target of graph.targets(edge)) {
      const node = target.to === undefined ? undefined : graph.node(target.to);
      if (node?.node.type !== "resource" || !isOptionalResourceInput((node.node as ResourceGraphNode).manifest)) continue;
      const input = (node.node as ResourceGraphNode).name;
      const absent = absentOf((node.node as ResourceGraphNode).manifest, input);
      const condition = space.and(target.held, absent);
      if (condition === FALSE) continue;
      const holder = graph.node(edge.from)?.node.type === "resource" ? edge.from : edge.owner;
      reportKeyCost({ kind: "pass-reading", pass: "optionalInputReferences", declaration: edge.declaration });
      references.push({ edge, holder, target: target.to!, input, absent, condition });
    }
  }
  return references;
}

/** Each import of the union forwarding an optional resource input, where it
 *  holds and `absentOf` says the input may be absent. */
export function forwardedOptionalInputs(
  union: ConditionedExpansion,
  absentOf: (manifest: ResourceManifest, input: string) => Condition,
): { reference: Parameters<typeof optionalInputReferenceMessage>[0]; condition: Condition }[] {
  const { space } = union;
  const optional = new Set<string>();
  for (const { manifest } of union.declarations) {
    if (isOptionalResourceInput(manifest)) optional.add(`${moduleOf(manifest) ?? ""}\0${manifest.metadata?.name}`);
  }
  const forwards: { reference: Parameters<typeof optionalInputReferenceMessage>[0]; condition: Condition }[] = [];
  for (const declaration of union.declarations) {
    const m = declaration.manifest;
    if (m.kind !== "Telo.Import" || !present(declaration) || optional.size === 0) continue;
    const module = moduleOf(m);
    for (const [key, value] of Object.entries(readSuppliedResources(m))) {
      const target = refSentinelTarget(value);
      if (!target || (target.alias !== undefined && target.alias !== "Self")) continue;
      if (!optional.has(`${module ?? ""}\0${target.name}`)) continue;
      const condition = space.and(declaration.condition, absentOf(m, target.name));
      if (condition === FALSE) continue;
      forwards.push({ reference: { input: target.name, holder: m, path: `resources.${key}` }, condition });
    }
  }
  return forwards;
}

/** The reference `reference` is, as `read` decides the choices naming and
 *  placing its holder. */
export function edgeReferenceAt(
  graph: ConditionedCallGraph,
  reference: EdgeReference,
  read: ChoiceDecider,
): Parameters<typeof optionalInputReferenceMessage>[0] {
  const identity = graph.identityBy(reference.holder, read);
  const path = graph.relativePathBy(reference.holder, reference.edge.keys, read);
  const holder = { ...identity.manifest, kind: identity.kind, metadata: { ...identity.manifest.metadata, name: identity.name } } as ResourceManifest;
  return { input: reference.input, holder, path };
}

/** The finding of an edge reference, as `read` decides the choices naming and
 *  placing its holder, before placement. */
export function edgeReferenceFinding(graph: ConditionedCallGraph, reference: EdgeReference, read: ChoiceDecider): AnalysisDiagnostic {
  const at = edgeReferenceAt(graph, reference, read);
  // A finding of a declaration written inside another stands at its place
  // there, as a run moves it.
  return aboutDeclaration(referenceDiagnostic(at, data(at.holder, at.path)), reference.holder);
}

/** The finding of an import forwarding an optional input, before placement. */
export function forwardedReferenceFinding(reference: Parameters<typeof optionalInputReferenceMessage>[0]): AnalysisDiagnostic {
  return referenceDiagnostic(reference, data(reference.holder, reference.path));
}

function data(holder: ResourceManifest, path: string) {
  return {
    resource: { kind: holder.kind, name: holder.metadata?.name as string },
    filePath: (holder.metadata as { source?: string } | undefined)?.source,
    path,
  };
}

function referenceDiagnostic(
  reference: Parameters<typeof optionalInputReferenceMessage>[0],
  at: ReturnType<typeof data>,
): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: "RESOURCE_INPUT_OPTIONAL_REFERENCED",
    source: "telo-analyzer",
    message: optionalInputReferenceMessage(reference),
    data: at,
  };
}

/**
 * `DEPENDENCY_CYCLE` over every configuration at once: the boot order's
 * dependency graph read off the conditioned call graph — each node and arc
 * with where it holds — and every loop with the configurations it is the one
 * reported in, by the one loop search the plain graph uses
 * (`dependencyLoops`). A loop among one scope's members is read the same way,
 * per scope.
 *
 * Each loop is rendered in the raw form a run's own finding takes, where it
 * holds; a branch no configuration takes is searched once, at its baseline
 * with its forcing.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { celResourceReads } from "./cel-access-chains.js";
import {
  compareRanks,
  type ConditionedCallGraph,
  type HeldAt,
  type HeldGraphEdge,
  type HeldGraphNode,
  type HeldTarget,
  type HeldView,
} from "./conditioned-call-graph.js";
import type { ChoiceDecider, ConditionedExpansion, World } from "./conditioned-expansion.js";
import type { ConditionedNameIndex, ConditionedOutcome, NamePopulation } from "./conditioned-name-index.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  BOOLEAN_LOGIC,
  dependencyLoops,
  dependencyParityLines,
  formatCycle,
  type ComponentReadings,
  type HeldDependencies,
  type LoopLogic,
  type ResourceNode,
} from "./dependency-graph.js";
import { governedCelEvalSites } from "./eval-paths.js";
import { definitionInScope, moduleAliasScope } from "./module-alias-scope.js";
import { needSupplyOf, readSuppliedNeeds } from "./need-type.js";
import { aboutDeclaration } from "./placement.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { readSuppliedResources } from "./resource-input.js";
import { scopeSiteKey } from "./scope-address.js";
import { parseKeys } from "./template-expansion.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type PassTable } from "./union-passes.js";
import { startupObservedStateReads } from "./validate-observed-state.js";
import { splitByReads, type DeadBranchRun, type WorldReader } from "./world-reader.js";

const SOURCE = "telo-analyzer";
type Keys = readonly (string | number)[];

export interface CycleFindingsInputs {
  readonly graph: ConditionedCallGraph;
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The configurations kept. */
  readonly universe: Condition;
  /** Runs a read of a kind's schema with the named shapes some configuration
   *  varies registered, every option kept. */
  readonly withShapes: <T>(read: () => T) => T;
  /** The branches no configuration takes, each searched once. */
  readonly deadBranches: readonly DeadBranchRun[];
  /** Emit the boot order's parity lines, for a check comparing them with a run's. */
  readonly parity?: boolean;
}

/** How a graph element holds, in the connectives `logic` computes in. */
interface CycleWorld<T> {
  readonly logic: LoopLogic<T>;
  at(element: HeldAt): T;
  targets(edge: HeldGraphEdge): HeldTarget<T>[];
  /** What `name`, read module-level in `module`, resolves to among every
   *  declaration, each outcome with where it holds. */
  named(population: NamePopulation, name: string, module: string | undefined): { to: string | undefined; held: T }[];
  readings: ComponentReadings<T>;
}

/** A node of the boot order: a declaration, an inline one a run extracts, or
 *  an import. */
interface BootNode extends HeldAt {
  readonly id: string;
  readonly order: readonly number[];
  readonly held: HeldGraphNode | undefined;
  readonly manifest: ResourceManifest;
  /** Every later declaration of the same id: a run's graph files them under
   *  the first. */
  readonly also: HeldGraphNode[];
}

/** One loop and where it is reported, in the graph of the scope it is in or
 *  the boot order's. */
interface LoopEntry {
  readonly keys: readonly string[];
  readonly held: Condition;
}

const outcomeTarget = (outcome: ConditionedOutcome): string | undefined =>
  outcome.outcome.status === "resolved" ? nodeId(outcome.outcome.declaration as ResourceManifest) : undefined;

/** The id the call graph keys a declaration by. */
function nodeId(manifest: ResourceManifest): string {
  const kind = manifest.kind as string;
  const name = manifest.metadata?.name as string;
  const module = (manifest.metadata as { module?: string } | undefined)?.module;
  const instance = (manifest.metadata as { importPath?: unknown } | undefined)?.importPath;
  const scoped = Array.isArray(instance) ? `${module}/${(instance as string[]).join("/")}` : module;
  return scoped ? `${scoped}\0${kind}\0${name}` : `${kind}\0${name}`;
}

const moduleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

/** What a supplied resource names: the import a cross-module reference goes
 *  through, else the name. */
function suppliedName(value: unknown): string | undefined {
  const sentinel = refSentinelTarget(value);
  const written = sentinel ?? (isResolvedReference(value) ? value : undefined);
  if (!written) return undefined;
  return written.alias && written.alias !== "Self" ? written.alias : written.name;
}

/** The names a `needs:` supply depends on, each at the place written. */
function needSupplyNames(supplied: Record<string, unknown>): { keys: Keys; name: string }[] {
  const out: { keys: Keys; name: string }[] = [];
  for (const [need, value] of Object.entries(supplied)) {
    const supply = needSupplyOf(value);
    if (supply.form === "whole") {
      const { alias, name } = supply.target;
      out.push({ keys: ["needs", need], name: alias && alias !== "Self" ? alias : name });
    } else if (supply.form === "fields") {
      for (const [field, fieldValue] of Object.entries(supply.fields)) {
        for (const name of celResourceReads({ fields: { [field]: fieldValue } } as unknown as ResourceManifest)) {
          out.push({ keys: ["needs", need, field], name });
        }
      }
    }
  }
  return out;
}

/** The cycle pass's table, and — asked for — the boot order's parity lines,
 *  each part with the configurations it is read in. */
export interface CycleFindings extends PassTable {
  readonly parity?: readonly { readonly condition: Condition; readonly lines: readonly string[] }[];
}

export function cycleFindings(inputs: CycleFindingsInputs): CycleFindings {
  const { graph, union, names, defs, aliases, aliasesByModule, rootModules, universe, withShapes } = inputs;
  const { space } = union;
  const declarationIndex = new Map([...union.declarations, ...union.views].map((d, i) => [d as object, i]));
  const viewCount = union.declarations.length;

  // The boot order's nodes, in the order a run's graph holds them.
  const bootNodes: BootNode[] = [];
  const firstOf = new Map<string, BootNode>();
  for (const node of graph.nodes) {
    if (node.node.type !== "resource" || node.site) continue;
    const known = firstOf.get(node.id);
    if (known) {
      known.also.push(node);
      continue;
    }
    const index = declarationIndex.get(node.declaration) ?? 0;
    const view = index >= viewCount ? 1 : 0;
    const order = node.extracted ? [view * 2 + 1, node.depth ?? 1, index, ...node.place] : [view * 2, index];
    const boot: BootNode = { ...node, order, held: node, manifest: node.extracted ? node.node.manifest : node.declaration.manifest, also: [] };
    firstOf.set(node.id, boot);
    bootNodes.push(boot);
  }
  const imports = union.declarations.filter((d) => d.manifest.kind === "Telo.Import" && typeof d.manifest.metadata?.name === "string");
  // An alias a module writes twice is one node, as in a run's graph: at the
  // first's place, read as the last (imports never vary, so each holds where
  // the other does).
  const importAt = new Map<string, { index: number; declaration: (typeof imports)[number] }>();
  imports.forEach((declaration, index) => {
    const id = nodeId(declaration.manifest);
    importAt.set(id, { index: importAt.get(id)?.index ?? index, declaration });
  });
  for (const [id, { index, declaration }] of importAt) {
    bootNodes.push({
      id,
      order: [4, index],
      held: undefined,
      manifest: declaration.manifest,
      condition: declaration.condition,
      holdings: [{ condition: declaration.condition, path: declaration.path }],
      also: [],
    });
  }
  bootNodes.sort((a, b) => compareRanks(a.order, b.order));
  const bootIds = new Set(bootNodes.map((n) => n.id));
  const bootById = new Map(bootNodes.map((n) => [n.id, n]));
  // Each import by the alias table it registers into.
  const importByScope = new Map<AliasResolver | undefined, Map<string, string>>();
  for (const declaration of imports) {
    const scope = moduleAliasScope(declaration.manifest.metadata, aliases, aliasesByModule);
    let byAlias = importByScope.get(scope);
    if (!byAlias) importByScope.set(scope, (byAlias = new Map()));
    byAlias.set(declaration.manifest.metadata!.name as string, nodeId(declaration.manifest));
  }
  const importNodeOf = (manifest: ResourceManifest, alias: string): string | undefined =>
    importByScope.get(moduleAliasScope(manifest.metadata, aliases, aliasesByModule))?.get(alias);
  /** The import a bare name names, read as a run's graph reads it. */
  const importNamed = (name: string, module: string | undefined): string | undefined => {
    const found = imports.filter((d) => d.manifest.metadata?.name === name);
    const one = found.length === 1 ? found[0] : found.find((d) => moduleOf(d.manifest) === module);
    return one ? nodeId(one.manifest) : undefined;
  };
  // Read once per kind, before any configuration's run opens its shapes.
  const sitesByDefinition = new Map<object, ReturnType<typeof governedCelEvalSites>>();
  const sitesOf = (definition: ResourceDefinition | undefined) => {
    if (!definition) return undefined;
    if (!sitesByDefinition.has(definition)) {
      sitesByDefinition.set(definition, withShapes(() => governedCelEvalSites(definition, defs, defs.shapeLookup)));
    }
    return sitesByDefinition.get(definition);
  };
  const viewsOf = new Map<object, HeldView[]>();
  for (const view of graph.views) {
    const list = viewsOf.get(view.declaration) ?? [];
    list.push(view);
    viewsOf.set(view.declaration, list);
  }

  /** The boot order's dependency graph and each scope's, as `world` holds them. */
  function dependenciesIn<T>(world: CycleWorld<T>): { boot: HeldDependencies<T>; scopes: HeldDependencies<T>[] } {
    const { logic } = world;
    const arcs = new Map<string, { to: string; held: T }[]>(bootNodes.map((n) => [n.id, []]));
    /** An arc, a reference to itself one only from the call graph. */
    const add = (from: string, to: string | undefined, held: T, self = false): void => {
      if (to === undefined || (to === from && !self) || !bootIds.has(to) || logic.isFalse(held)) return;
      arcs.get(from)!.push({ to, held });
    };
    // The call graph's injection sites and module calls, every use but `schema`.
    for (const node of bootNodes) {
      if (!node.held) continue;
      for (const edge of graph.edgesOf(node.id)) {
        if (!edge.edge.injected && !edge.edge.moduleCall) continue;
        const use = edge.edge.use;
        if (!(use.length === 0 || use.some((u) => u !== "schema"))) continue;
        for (const target of world.targets(edge)) {
          if (!target.scoped) add(node.id, target.to, target.held, true);
        }
      }
    }
    // What each import is handed and what its needs supply read.
    for (const declaration of imports) {
      const id = nodeId(declaration.manifest);
      const module = moduleOf(declaration.manifest);
      const found: { order: number[]; to: string | undefined; held: T }[] = [];
      for (const view of viewsOf.get(declaration) ?? []) {
        const manifest = view.manifests[0]!.manifest;
        const reads: { keys: Keys; name: string }[] = [];
        for (const [input, value] of Object.entries(readSuppliedResources(manifest))) {
          const name = suppliedName(value);
          if (name !== undefined) reads.push({ keys: ["resources", input], name });
        }
        reads.push(...needSupplyNames(readSuppliedNeeds(manifest)));
        for (const read of reads) {
          if (!view.home(read.keys)) continue;
          const order = view.orderOf(read.keys);
          const viewHeld = world.at(view);
          const viaImport = importNamed(read.name, module);
          if (viaImport) {
            found.push({ order, to: viaImport, held: viewHeld });
            continue;
          }
          for (const outcome of world.named("declaredNodes", read.name, module)) {
            found.push({ order, to: outcome.to, held: logic.and(viewHeld, outcome.held) });
          }
        }
      }
      found.sort((a, b) => compareRanks(a.order, b.order));
      for (const each of found) add(id, each.to, each.held);
    }
    // A reference through an import alias at a resource's own slot orders it
    // after that import.
    for (const node of bootNodes) {
      if (!node.held) continue;
      for (const edge of graph.edgesOf(node.id)) {
        const { alias, injected, nested } = edge.edge;
        if (alias === undefined || !injected || nested || edge.from !== node.id) continue;
        add(node.id, importNodeOf(node.manifest, alias), world.at(edge));
      }
    }
    // A startup read of another resource's observed state.
    for (const node of bootNodes) {
      if (!node.held) continue;
      const found: { order: number[]; to: string | undefined; held: T }[] = [];
      for (const view of [node.held, ...node.also].flatMap((held) => viewsOf.get(held.declaration) ?? [])) {
        const entry = view.manifests.find((m) => m.id === node.id);
        if (!entry) continue;
        const { manifest } = entry;
        const sites = sitesOf(
          definitionInScope<ResourceDefinition>(defs, manifest.kind as string, manifest.metadata, aliases, aliasesByModule),
        );
        if (!sites) continue;
        const module = moduleOf(manifest);
        for (const read of startupObservedStateReads(manifest, sites)) {
          const keys = [...entry.keys, ...parseKeys(read.path ?? "")];
          if (!view.home(keys)) continue;
          const order = view.orderOf(keys);
          if (read.alias !== undefined) {
            found.push({ order, to: importNodeOf(manifest, read.alias), held: world.at(view) });
            continue;
          }
          for (const outcome of world.named("declaredNodes", read.name, module)) {
            if (outcome.to !== undefined && bootById.get(outcome.to)?.manifest.kind === "Telo.Import") continue;
            found.push({ order, to: outcome.to, held: logic.and(world.at(view), outcome.held) });
          }
        }
      }
      found.sort((a, b) => compareRanks(a.order, b.order));
      for (const each of found) add(node.id, each.to, each.held);
    }
    const boot: HeldDependencies<T> = {
      nodes: bootNodes.map((n) => n.id),
      present: (id) => {
        const node = bootById.get(id)!;
        return node.also.reduce((held, other) => logic.or(held, world.at(other)), world.at(node));
      },
      arcs: (id) => arcs.get(id) ?? [],
    };
    // Each scope's members and the arcs among them.
    const groups = new Map<string, HeldGraphNode[]>();
    for (const node of graph.nodes) {
      if (!node.site || node.node.type !== "resource") continue;
      const key = scopeSiteKey(node.site);
      const list = groups.get(key) ?? [];
      if (!list.some((member) => member.id === node.id)) list.push(node);
      groups.set(key, list);
    }
    const scopes: HeldDependencies<T>[] = [];
    for (const members of groups.values()) {
      const ids = new Set(members.map((m) => m.id));
      const memberArcs = new Map<string, { to: string; held: T }[]>();
      for (const member of members) {
        const list: { to: string; held: T }[] = [];
        for (const edge of graph.edgesOf(member.id)) {
          if (edge.from !== member.id || edge.edge.nested || edge.edge.moduleCall) continue;
          if (edge.edge.use.length > 0 && edge.edge.use.every((u) => u === "schema")) continue;
          for (const target of world.targets(edge)) {
            if (target.to !== undefined && target.scoped && ids.has(target.to) && !logic.isFalse(target.held)) {
              list.push({ to: target.to, held: target.held });
            }
          }
        }
        memberArcs.set(member.id, list);
      }
      const ordered = [...members].sort((a, b) => compareRanks(a.place, b.place));
      // A member is read once per view holding it; it is there where any is.
      const present = new Map<string, T>();
      for (const node of graph.nodes) {
        if (ids.has(node.id)) present.set(node.id, logic.or(present.get(node.id) ?? logic.FALSE, world.at(node)));
      }
      scopes.push({
        nodes: ordered.map((m) => m.id),
        present: (id) => present.get(id) ?? logic.FALSE,
        arcs: (id) => memberArcs.get(id) ?? [],
      });
    }
    return { boot, scopes };
  }

  const conditions: CycleWorld<Condition> = {
    logic: {
      TRUE,
      FALSE,
      and: (a, b) => space.and(a, b),
      or: (a, b) => space.or(a, b),
      not: (a) => space.not(a),
      isFalse: (a) => a === FALSE,
    },
    at: (element) => element.condition,
    targets: (edge) => graph.targets(edge),
    named: (population, name, module) =>
      names.locate(population, name, module).map((o) => ({ to: outcomeTarget(o), held: o.condition })),
    readings: (elements) => readingsOf(space, elements, universe),
  };
  const { boot, scopes } = dependenciesIn(conditions);
  const entries: { loop: LoopEntry; scoped: boolean }[] = [
    ...dependencyLoops(conditions.logic, boot, conditions.readings).map((loop) => ({ loop, scoped: false })),
    ...scopes.flatMap((scope) =>
      dependencyLoops(conditions.logic, scope, conditions.readings, { firstLoop: false }).map((loop) => ({ loop, scoped: true })),
    ),
  ];

  /** A loop's finding as a run builds it where `read` decides the choices. */
  const render = (keys: readonly string[], read: ChoiceDecider): AnalysisDiagnostic[] => {
    const nodes = keys.map((id) => resourceNodeBy(id, read));
    const own = nodes.filter((node) => {
      const module = moduleOf(node.manifest);
      return !module || rootModules.has(module);
    });
    // A loop through an import is reported at the import.
    const anchor = own.find((node) => node.kind === "Telo.Import") ?? own[0];
    if (!anchor) return [];
    const found: AnalysisDiagnostic = {
      severity: DiagnosticSeverity.Error,
      code: "DEPENDENCY_CYCLE",
      source: SOURCE,
      message: formatCycle(nodes),
      data: {
        resource: { kind: anchor.kind, name: anchor.name },
        filePath: (anchor.manifest.metadata as { source?: string } | undefined)?.source,
        path: "metadata.name",
      },
    };
    const id = keys[nodes.indexOf(anchor)]!;
    return [graph.node(id) ? aboutDeclaration(found, id) : found];
  };

  /** A node of a loop as a run's graph holds it where `read` decides. */
  const resourceNodeBy = (id: string, read: ChoiceDecider): ResourceNode => {
    const boot = bootById.get(id);
    if (boot && !boot.held) {
      return { kind: boot.manifest.kind as string, name: boot.manifest.metadata?.name as string, manifest: boot.manifest };
    }
    return graph.identityBy(id, read);
  };

  /** `held`'s nodes and their targets where `read` holds, each target where
   *  its first arc holding there puts it. */
  const heldBy = (held: HeldDependencies<Condition>, read: WorldReader<Condition>) => ({
    nodes: held.nodes.filter((id) => read.holds(held.present(id))),
    targets: (id: string) => [...new Set(held.arcs(id).filter((arc) => read.holds(arc.held)).map((arc) => arc.to))],
  });
  const identity = (id: string, read: ChoiceDecider): string => {
    const node = resourceNodeBy(id, read);
    return `${node.kind} ${node.name} ${moduleOf(node.manifest) ?? ""}`;
  };

  const dead = readDeadBranches("cycles", inputs.deadBranches, (branch) => {
    const witness: World = branch.world;
    const world: CycleWorld<boolean> = {
      logic: BOOLEAN_LOGIC,
      at: (element) => graph.holdsAt(element, witness),
      targets: (edge) => {
        const target = graph.targetAt(edge, witness);
        return target ? [target] : [];
      },
      named: (population, name, module) => {
        const outcome = names.locateAt(population, name, module, undefined, witness);
        return [{ to: outcomeTarget(outcome), held: true }];
      },
      readings: () => [{ held: true, holds: (element) => element }],
    };
    const found = dependenciesIn(world);
    return [
      ...dependencyLoops(BOOLEAN_LOGIC, found.boot, world.readings),
      ...found.scopes.flatMap((scope) => dependencyLoops(BOOLEAN_LOGIC, scope, world.readings, { firstLoop: false })),
    ].map((loop) => ({ branch, render: (read: ChoiceDecider) => render(loop.keys, read) }));
  });
  const parity = inputs.parity
    ? splitByReads(space, universe, (read) =>
        dependencyParityLines(
          heldBy(boot, read),
          scopes.map((scope) => heldBy(scope, read)),
          (id) => identity(id, read),
        ),
      ).map(({ condition, value }) => ({ condition, lines: value }))
    : undefined;
  return {
    ...(parity ? { parity } : {}),
    found: entries.map((entry) => ({ held: entry.loop.held, render: (read) => render(entry.loop.keys, read) })),
    dead,
  };
}

/** The classes `elements` take over the configurations kept: each decides
 *  every element alike, found from the first configuration the rest leave. */
export function readingsOf(
  space: ConditionSpace,
  elements: readonly Condition[],
  universe: Condition,
): { held: Condition; holds(element: Condition): boolean }[] {
  const distinct = [...new Set(elements)];
  let remaining = space.and(
    distinct.reduce((all, e) => space.or(all, e), FALSE as Condition),
    universe,
  );
  const out: { held: Condition; holds(element: Condition): boolean }[] = [];
  while (remaining !== FALSE) {
    const witness = space.firstAssignment(remaining)!;
    let held = TRUE as Condition;
    for (const element of distinct) held = space.and(held, space.holds(element, witness) ? element : space.not(element));
    out.push({ held, holds: (element) => space.holds(element, witness) });
    remaining = space.and(remaining, space.not(held));
  }
  return out;
}

/**
 * Zone requirements over every configuration at once: the projection of
 * `resolve-zone-requirements.ts` — origins, propagation callee→caller,
 * discharge under the correlation rule, the edge rule
 * (`requirementEdgeVerdict`) — run once over the conditioned call graph, each
 * requirement, visit and finding carrying where it holds.
 *
 * A requirement's correlation and a provider's are read from the places the
 * key pointers name, past each reference they cross, each option on the way
 * with where it is taken; two correlations are the same declaration site where
 * they resolve to it. Each finding is rendered in the raw form a run's own
 * finding takes, read where it holds; a branch no configuration takes is
 * projected once, at its baseline with its forcing.
 *
 * Browser-safe.
 */
import { aboutDeclaration } from "./placement.js";
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { ResourceGraphNode, StepGraphNode } from "./call-graph.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import {
  compareRanks,
  reachedBy,
  type ConditionedCallGraph,
  type GraphWorld,
  type HeldGraphEdge,
  type HeldGraphNode,
} from "./conditioned-call-graph.js";
import {
  isAlternatives,
  takenAt,
  type AlternativeOption,
  type ConditionedExpansion,
  type ChoiceDecider,
  type World,
} from "./conditioned-expansion.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isGeneratedDeclaration, shownDeclaration } from "./generated-name.js";
import type { ModuleDocuments } from "./module-documents.js";
import type { Condition } from "./presence-condition.js";
import { importAnchoredDiagnostic, importReach, type ReachingImport } from "./reaching-import.js";
import { NOT_AN_INPUT, resourceInputBinding } from "./resource-input-binding.js";
import { isInjectedDeclaration } from "./resource-input.js";
import {
  acceptedZones,
  attributesMissingWhy,
  BOOT_TARGETS_WHY,
  canonicalOf,
  definitionResolver,
  dottedPattern,
  exportNameOf,
  exportUnsatisfiable,
  importsClosure,
  refName,
  requirementEdgeVerdict,
  requirementMessage,
  requirementSeeds,
  requirementSlotsOf,
  rootLibraryExports,
  schemaNodeAt,
  type ZoneExportCache,
  type ZoneRequirementSpec,
} from "./resolve-zone-requirements.js";
import type { ScopeSite } from "./scope-address.js";
import { importPathOf } from "./scoped-name-resolver.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type PassTable } from "./union-passes.js";
import type { DeadBranchRun } from "./world-reader.js";
import { readProvidesZone } from "./zone-slot.js";

const SOURCE = "telo-analyzer";
type Keys = readonly (string | number)[];

export interface ZoneRequirementInputs {
  readonly graph: ConditionedCallGraph;
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly moduleDocuments?: readonly ModuleDocuments[];
  readonly cache?: ZoneExportCache;
  /** The branches no configuration takes, each projected once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** One outcome of a name and where it holds. */
interface Named<T> {
  readonly to: string | undefined;
  readonly scoped: boolean;
  readonly held: T;
}

/** The graph, the options of the union and the conditioned names, read in the
 *  connectives `T` computes in. */
interface ZoneWorld<T> extends GraphWorld<T> {
  option(option: AlternativeOption): T;
  locate(name: string, module: string | undefined, within: ScopeSite | undefined): Named<T>[];
  inModule(name: string, module: string, importPath: readonly string[] | undefined): Named<T>[];
}

interface Requirement {
  readonly zone: string;
  readonly accepted: ReadonlySet<string>;
  readonly attributes: readonly string[];
  /** The correlated declaration site, as {@link correlationOf} keys it. */
  readonly correlation?: string;
  readonly correlationLabel?: string;
  readonly correlationName?: string;
  readonly correlationInput?: string;
  readonly reason?: string;
  readonly origin: string;
  readonly originModule?: string;
  readonly key: string;
}

/** A finding, where it holds, and its raw form where `read` decides. */
interface Found<T> {
  readonly held: T;
  render(read: ChoiceDecider): AnalysisDiagnostic;
}

const moduleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

export function zoneRequirementFindings(inputs: ZoneRequirementInputs): PassTable {
  const { graph, union, names, defs, aliases, aliasesByModule, rootModules } = inputs;
  const { space } = union;
  const manifests = union.declarations.map((d) => d.manifest);
  const resolveDef = definitionResolver(defs, aliases, aliasesByModule);
  const seeds = requirementSeeds(inputs.moduleDocuments, defs, aliases, aliasesByModule, inputs.cache);
  const rootLibraries = rootLibraryExports(manifests, rootModules);
  const reach = importReach(manifests, rootModules);
  const imports = importsClosure(manifests);

  const resourceOf = (id: string): ResourceGraphNode => graph.node(id)!.node as ResourceGraphNode;
  const shownName = (id: string): string => {
    const node = resourceOf(id);
    return shownDeclaration(node.kind, node.name, node.manifest);
  };
  const labelOf = (id: string): string => {
    const node = resourceOf(id);
    return isGeneratedDeclaration(node.manifest) ? shownName(id) : `${node.kind} '${node.name}'`;
  };
  /** A declaration site's identity: a scope member by its scope, an extracted
   *  declaration by where it is written, anything else by its file and name. */
  const correlationOf = (id: string): string => {
    const held = graph.node(id)!;
    const node = held.node as ResourceGraphNode;
    if (held.extracted) return `extracted\0${id}`;
    if (held.site) return `${held.owner ?? ""}\0${held.site.field}\0${node.name}`;
    return `${(node.manifest.metadata as { source?: string } | undefined)?.source ?? ""}\0${node.name}`;
  };

  // Scope members in the order a run's graph declares them: by holder, then
  // where each is written.
  const scopedNodes = graph.nodes
    .filter((n) => n.node.type === "resource" && n.site)
    .map((n) => {
      let top: HeldGraphNode | undefined = n;
      let depth = 0;
      while (top?.site && top.owner !== undefined) {
        top = graph.node(top.owner);
        depth++;
      }
      const at = top ? graph.resourceNodes().findIndex((r) => r.id === top!.id) : -1;
      return { node: n, order: [at, depth, ...n.place] };
    })
    .sort((a, b) => compareRanks(a.order, b.order))
    .map((entry) => entry.node);
  const moduleScope = graph.resourceNodes().flatMap((n) => graph.readingsOf(n.id).filter((r) => !r.site));
  const allResources = [...moduleScope, ...scopedNodes];

  function project<T>(world: ZoneWorld<T>): { found: Found<T>[] } {
    const L = world.logic;
    const found: Found<T>[] = [];
    const visited = new Map<string, T>();
    const reported = new Map<string, T>();
    const openExports = new Map<string, { key: string; spec: ZoneRequirementSpec; held: T }[]>();
    const firstExport = new Map<string, T>();

    const lookups = new Map<string, Named<T>[]>();
    const inputsBound = resourceInputBinding<Named<T>[]>(
      manifests,
      {
        inModule: (name, module, importPath) => {
          const key = JSON.stringify([name, module, importPath ?? null]);
          let known = lookups.get(key);
          if (!known) lookups.set(key, (known = world.inModule(name, module, importPath)));
          return known;
        },
      },
      aliases,
      aliasesByModule,
    );
    const orOf = (items: readonly { held: T }[]): T => items.reduce((all, i) => L.or(all, i.held), L.FALSE);

    /** What `name`, written in `from`, names: its own scope's member, else what
     *  an importer supplied for a library input of that name, else the name in
     *  the module. */
    const resolveName = (name: string, from: HeldGraphNode): Named<T>[] => {
      const manifest = (from.node as ResourceGraphNode).manifest;
      const module = moduleOf(manifest);
      const located = world.locate(name, module, from.site);
      const bound = inputsBound.bound(name, module, importPathOf(manifest));
      if (bound === NOT_AN_INPUT) return located;
      const member = located.filter((o) => o.scoped && o.to !== undefined);
      const rest = L.not(orOf(member));
      const supplied = bound ?? [{ to: undefined, scoped: false, held: L.TRUE }];
      return [
        ...member,
        ...supplied.map((o) => ({ ...o, held: L.and(o.held, rest) })).filter((o) => !L.isFalse(o.held)),
      ];
    };

    /** The value at `keys` of `node`'s declaration, the node's own options taken
     *  on the way; a choice at the last key is returned as written. */
    const rawAt = (node: HeldGraphNode, keys: Keys): unknown => {
      let value: unknown = node.declaration.manifest;
      for (const key of keys) {
        while (isAlternatives(value)) {
          const option = value.options[node.taken.get(value) ?? -1];
          if (!option?.present) return undefined;
          value = option.value;
        }
        if (value === null || typeof value !== "object") return undefined;
        value = (value as Record<string | number, unknown>)[key];
      }
      return value;
    };
    /** Each way `value` reads where `held` holds, its choices' options taken. */
    const readings = (value: unknown, held: T): { value: unknown; held: T }[] => {
      if (!isAlternatives(value)) return [{ value, held }];
      return value.options.flatMap((option) => {
        const at = L.and(held, world.option(option));
        if (L.isFalse(at)) return [];
        return option.present ? readings(option.value, at) : [{ value: undefined, held: at }];
      });
    };

    /** The declaration an ordered key-pointer list resolves to from the object
     *  at `keys` of `start`, first hit winning, read with `context`'s names. */
    const resolveKey = (start: HeldGraphNode, keys: Keys, pointers: readonly string[], held: T): Named<T>[] => {
      const out: Named<T>[] = [];
      let remaining = held;
      for (const pointer of pointers) {
        if (!pointer.startsWith("/") || L.isFalse(remaining)) continue;
        const segments = pointer
          .slice(1)
          .split("/")
          .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
        let values: { value: unknown; context: HeldGraphNode; place: { node: HeldGraphNode; keys: Keys }; held: T }[] = [];
        segments.forEach((segment, i) => {
          const places: { node: HeldGraphNode; keys: Keys; context: HeldGraphNode; held: T }[] = [];
          if (i === 0) places.push({ node: start, keys, context: start, held: remaining });
          else {
            for (const v of values) {
              const name = refName(v.value);
              if (name === undefined) continue;
              for (const target of resolveName(name, v.context)) {
                if (target.to === undefined) continue;
                const at = L.and(v.held, target.held);
                if (L.isFalse(at)) continue;
                const node = graph.node(target.to);
                if (node) places.push({ node, keys: node.keys, context: node, held: at });
              }
            }
          }
          values = places.flatMap((place) =>
            readings(rawAt(place.node, [...place.keys, segment]), place.held)
              .filter((r) => r.value !== undefined && r.value !== null)
              .map((r) => ({ value: r.value, context: place.context, place, held: r.held })),
          );
        });
        const hits: Named<T>[] = [];
        for (const v of values) {
          const name = refName(v.value);
          if (name === undefined) continue;
          for (const target of resolveName(name, v.context)) {
            if (target.to === undefined) continue;
            const at = L.and(v.held, target.held);
            if (!L.isFalse(at)) hits.push({ to: target.to, scoped: target.scoped, held: at });
          }
        }
        out.push(...hits);
        remaining = L.and(remaining, L.not(orOf(hits)));
      }
      if (!L.isFalse(remaining)) out.push({ to: undefined, scoped: false, held: remaining });
      return out;
    };

    const reportable = (manifest: ResourceManifest): boolean => {
      const module = moduleOf(manifest);
      return module === undefined || rootModules.has(module);
    };

    const emit = (
      held: T,
      severity: DiagnosticSeverity,
      code: string,
      edge: HeldGraphEdge,
      caller: string,
      req: Requirement,
      via: readonly string[],
      why: string,
    ): void => {
      const callerManifest = resourceOf(caller).manifest;
      let anchor: { module: string; via: ReachingImport } | undefined;
      if (!reportable(callerManifest)) {
        const at = moduleOf(callerManifest);
        const arose = req.originModule;
        if (at === undefined || arose === undefined) return;
        const fromEntry = rootModules.has(arose);
        if (!fromEntry && (arose === at || imports(at, arose) || imports(arose, at))) return;
        const module = fromEntry ? at : arose;
        const through = reach.of(module);
        if (!through) return;
        anchor = { module, via: through };
      }
      const dedupe = `${code}\0${edge.from}\0${JSON.stringify(edge.keys)}\0${req.key}`;
      const prior = reported.get(dedupe) ?? L.FALSE;
      const at = L.and(held, L.not(prior));
      if (L.isFalse(at)) return;
      reported.set(dedupe, L.or(prior, at));
      found.push({
        held: at,
        render: (read) => {
          const relative = graph.relativePathBy(edge.owner, edge.keys, read);
          const path = [...via, `${shownName(caller)}.${relative}`].join(" → ");
          const message = requirementMessage(req, path, why);
          // Arising from what the consumer composes, no library's own check reports it.
          if (anchor) return { ...importAnchoredDiagnostic(code, anchor.module, anchor.via, message, null), severity };
          const identity = graph.identityBy(caller, read);
          return aboutDeclaration(
            {
              severity,
              code,
              source: SOURCE,
              message,
              data: {
                resource: { kind: identity.kind, name: identity.name },
                filePath: (callerManifest.metadata as { source?: string } | undefined)?.source,
                path: relative,
              },
            },
            caller,
          );
        },
      });
    };

    const propagate = (id: string, req: Requirement, via: readonly string[], held: T): void => {
      const visitKey = `${id}\0${req.key}`;
      const prior = visited.get(visitKey) ?? L.FALSE;
      const here = L.and(held, L.not(prior));
      if (L.isFalse(here)) return;
      visited.set(visitKey, L.or(prior, here));

      const node = graph.node(id)!;
      reportKeyCost({ kind: "pass-reading", pass: "zoneRequirements", declaration: node.declaration });
      const exportName =
        rootLibraries.length > 0 && !node.site
          ? exportNameOf(rootLibraries, resourceOf(id).manifest, resourceOf(id).name)
          : undefined;
      if (exportName !== undefined) {
        const firstKey = `${exportName}\0${req.zone}\0${req.correlation ?? ""}`;
        const first = firstExport.get(firstKey) ?? L.FALSE;
        const recorded = L.and(here, L.not(first));
        if (!L.isFalse(recorded)) {
          firstExport.set(firstKey, L.or(first, recorded));
          const bucket = openExports.get(exportName) ?? [];
          bucket.push({
            key: req.key,
            held: recorded,
            spec: {
              zone: req.zone,
              ...(req.attributes.length > 0 ? { attributes: [...req.attributes] } : {}),
              correlation: req.correlation,
              correlationLabel: req.correlationLabel,
              correlationName: req.correlationName,
              ...(req.correlationInput !== undefined ? { correlationInput: req.correlationInput } : {}),
              reason: req.reason,
              origin: req.origin,
              via: [...via],
            },
          });
          openExports.set(exportName, bucket);
        }
      }

      for (const { edge, held: reaching } of world.incoming(id)) {
        let at = L.and(here, reaching);
        if (L.isFalse(at)) continue;
        const caller = edge.owner;
        const callerNode = graph.node(caller);
        if (!callerNode || callerNode.node.type !== "resource") continue;
        const fromStep = edge.from !== edge.owner;
        const callerResource = callerNode.node as ResourceGraphNode;
        const callerDef = resolveDef(callerResource.kind, moduleOf(callerResource.manifest));
        const stepNode = fromStep ? (graph.node(edge.from)?.node as StepGraphNode | undefined) : undefined;
        const bodySlot = stepNode
          ? dottedPattern(stepNode.array.replace(/\[\d+\].*$/, ""))
          : (edge.edge.slotKeys ?? dottedPattern(edge.edge.slot));
        const provides = readProvidesZone(schemaNodeAt(callerDef?.schema as Record<string, any> | undefined, bodySlot));
        if (provides && callerDef && req.accepted.has(canonicalOf(callerDef))) {
          let discharged: T;
          if (req.correlation === undefined) discharged = L.TRUE;
          else if (!provides.key) discharged = L.FALSE;
          else {
            const relative = edge.keys.slice(callerNode.keys.length);
            const last = relative[relative.length - 1];
            const base = stepNode || relative.length <= 1 || typeof last === "number" ? callerNode.keys : edge.keys.slice(0, -1);
            discharged = orOf(
              resolveKey(callerNode, base, [provides.key], at).filter(
                (k) => k.to !== undefined && correlationOf(k.to) === req.correlation,
              ),
            );
          }
          const inZone = L.and(at, discharged);
          if (!L.isFalse(inZone)) {
            const missing = req.attributes.filter((a) => !(a in provides.attributes));
            if (missing.length > 0) {
              emit(inZone, DiagnosticSeverity.Error, "ZONE_ATTRIBUTE_MISSING", edge, caller, req, via, attributesMissingWhy(canonicalOf(callerDef), missing));
            }
            at = L.and(at, L.not(discharged));
            if (L.isFalse(at)) continue;
          }
        }
        const verdict = requirementEdgeVerdict(edge.edge);
        if (verdict.kind === "emit") emit(at, verdict.severity, verdict.code, edge, caller, req, via, verdict.why);
        else if (verdict.kind === "continue") {
          if (callerResource.kind === "Telo.Application") {
            emit(at, DiagnosticSeverity.Error, "ZONE_REQUIREMENT_UNSATISFIED", edge, caller, req, via, BOOT_TARGETS_WHY);
          } else {
            propagate(caller, req, [...via, shownName(caller)], at);
          }
        }
      }
    };

    // Origins: each resource whose kind requires a zone, where the annotated
    // field is written.
    for (const node of allResources) {
      const resource = node.node as ResourceGraphNode;
      if (isForwardedDeclaration(resource.manifest)) continue;
      const module = moduleOf(resource.manifest);
      const def = resolveDef(resource.kind, module);
      const schema = def?.schema as Record<string, any> | undefined;
      if (!def || !schema) continue;
      for (const { requires, field } of requirementSlotsOf(schema)) {
        let held = world.at(node);
        if (field !== undefined) {
          const holdings = graph.memberHoldings(node, field);
          held = L.and(
            held,
            holdings.reduce((all, list) => L.or(all, list.reduce((h, each) => L.and(h, world.at({ condition: each.condition, holdings: [each] })), L.TRUE)), L.FALSE),
          );
        }
        if (L.isFalse(held)) continue;
        const zoneDef = resolveDef(requires.zone, def.metadata.module);
        if (!zoneDef) continue;
        const zone = canonicalOf(zoneDef);
        for (const target of resolveKey(node, node.keys, requires.key, held)) {
          const correlation = target.to !== undefined ? correlationOf(target.to) : undefined;
          const req: Requirement = {
            zone,
            accepted: acceptedZones(defs, zone),
            attributes: requires.attributes,
            ...(target.to !== undefined
              ? {
                  correlation,
                  correlationLabel: labelOf(target.to),
                  correlationName: resourceOf(target.to).name,
                  ...(isInjectedDeclaration(resourceOf(target.to).manifest) ? { correlationInput: resourceOf(target.to).name } : {}),
                }
              : {}),
            reason: requires.reason,
            origin: labelOf(node.id),
            ...(module !== undefined ? { originModule: module } : {}),
            key: `${zone}\0${correlation ?? ""}`,
          };
          propagate(node.id, req, [shownName(node.id)], target.held);
        }
      }
    }

    // Seeds: imported libraries' derived export contracts, at the forwarded
    // nodes the set holds.
    if (seeds.size > 0) {
      for (const node of moduleScope) {
        const resource = node.node as ResourceGraphNode;
        const meta = resource.manifest.metadata as
          | { module?: string; forwardedExport?: boolean; forwardedInternal?: boolean; xTeloOrigin?: unknown }
          | undefined;
        if (!(meta?.forwardedExport || meta?.forwardedInternal) || meta.xTeloOrigin || !meta.module) continue;
        const specs = seeds.get(`${meta.module}\0${resource.name}`);
        if (!specs) continue;
        for (const spec of specs) {
          const zoneDef = defs.resolve(spec.zone);
          const rebound =
            spec.correlationInput === undefined
              ? NOT_AN_INPUT
              : inputsBound.bound(spec.correlationInput, meta.module, importPathOf(resource.manifest));
          const base = {
            zone: spec.zone,
            accepted: zoneDef ? acceptedZones(defs, spec.zone) : new Set([spec.zone]),
            attributes: spec.attributes ?? [],
            reason: spec.reason,
            origin: spec.origin,
            originModule: meta.module,
          };
          const correlations: { req: Requirement; held: T }[] =
            rebound === NOT_AN_INPUT
              ? [
                  {
                    req: {
                      ...base,
                      correlation: spec.correlation,
                      correlationLabel: spec.correlationLabel,
                      correlationName: spec.correlationName,
                      key: `${spec.zone}\0${spec.correlation ?? ""}`,
                    },
                    held: world.at(node),
                  },
                ]
              : (rebound ?? [{ to: undefined, scoped: false, held: L.TRUE }]).map((target) => {
                  const correlation = target.to !== undefined ? correlationOf(target.to) : undefined;
                  return {
                    req: {
                      ...base,
                      ...(target.to !== undefined
                        ? {
                            correlation,
                            correlationLabel: labelOf(target.to),
                            correlationName: resourceOf(target.to).name,
                            ...(isInjectedDeclaration(resourceOf(target.to).manifest) ? { correlationInput: resourceOf(target.to).name } : {}),
                          }
                        : {}),
                      key: `${spec.zone}\0${correlation ?? ""}`,
                    },
                    held: L.and(world.at(node), target.held),
                  };
                });
          for (const { req, held } of correlations) {
            if (!L.isFalse(held)) propagate(node.id, req, [...spec.via], held);
          }
        }
      }
    }

    // An export carrying a requirement on a resource importers cannot reach.
    for (const lib of rootLibraries) {
      for (const [exportName, specs] of openExports) {
        if (!lib.exportedNames.has(exportName)) continue;
        const exported = moduleScope.filter((n) => {
          const resource = n.node as ResourceGraphNode;
          return resource.name === exportName && moduleOf(resource.manifest) === lib.module;
        });
        for (const node of exported) {
          const resource = node.node as ResourceGraphNode;
          for (const { spec, held } of specs) {
            const at = L.and(held, world.at(node));
            const diagnostic = exportUnsatisfiable(lib, exportName, spec, resource);
            if (diagnostic && !L.isFalse(at)) found.push({ held: at, render: () => diagnostic });
          }
        }
      }
    }
    return { found };
  }

  const conditions = project<Condition>({
    ...graph.conditionWorld(),
    option: (option) => option.condition,
    locate: (name, module, within) =>
      names.locate("declaredNodes", name, module, within).map((o) => ({ ...reachedBy(o), held: o.condition })),
    inModule: (name, module, importPath) =>
      names.inModule("declaredNodes", name, module, importPath).map((o) => ({ ...reachedBy(o), held: o.condition })),
  });

  return {
    found: conditions.found.map((entry) => ({ held: entry.held, render: (read) => [entry.render(read)] })),
    dead: readDeadBranches("zoneRequirements", inputs.deadBranches, (branch) => {
      const witness: World = branch.world;
      const world: ZoneWorld<boolean> = {
        ...graph.witnessWorld(witness),
        option: (option) => takenAt(space, option.condition, option.path, witness.assignment, witness.forcing),
        locate: (name, module, within) => [{ ...reachedBy(names.locateAt("declaredNodes", name, module, within, witness)), held: true }],
        inModule: (name, module, importPath) => [
          { ...reachedBy(names.inModuleAt("declaredNodes", name, module, importPath, witness)), held: true },
        ],
      };
      return project(world).found.map((entry) => ({ branch, render: (read: ChoiceDecider) => [entry.render(read)] }));
    }),
  };
}

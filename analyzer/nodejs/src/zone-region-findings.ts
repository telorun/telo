/**
 * Zone regions over every configuration at once: the containment walk of
 * `resolve-zone-containment.ts` run once over the conditioned call graph —
 * each region, each node it contains and each dispatch leaving it with where
 * it holds, the route to a node being the one the walk takes first there —
 * and the checks over regions, each by its plain pass's own rule:
 * `ZONE_ATTRIBUTE_VIOLATED` (`validate-zone-violations.ts`) and the durable
 * checks (`validate-durable-regions.ts`), `DURABLE_CONTRACT_REQUIRED` among them.
 *
 * A value a rule reads whole — a retry policy, a declared output — is judged
 * once per way its own choices write it; a CEL leaf once where it is written.
 * A module call's determinism is the function it reaches: judged once where no
 * function varies, else once per reading of the functions that do.
 *
 * Each finding is rendered in the raw form a run's own finding takes, read
 * where it holds; a branch no configuration takes is walked once, at its
 * baseline with its forcing.
 *
 * Browser-safe.
 */
import { aboutDeclaration } from "./placement.js";
import { isCompiledValue, ZONE_ATTRIBUTES, type ResourceManifest } from "@telorun/sdk";
import { celExpressionsOf, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { ResourceGraphNode, StepGraphNode } from "./call-graph.js";
import type { CallableFlags } from "./callable-flags.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import {
  compareRanks,
  type ConditionedCallGraph,
  type GraphWorld,
  type HeldGraphEdge,
  type HeldGraphNode,
} from "./conditioned-call-graph.js";
import {
  isAlternatives,
  takenAt,
  type AlternativeOption,
  type ChoiceDecider,
  type ConditionedExpansion,
  World,
} from "./conditioned-expansion.js";
import { readingsOf } from "./cycle-findings.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { shownDeclaration } from "./generated-name.js";
import { moduleCallNamesOf } from "./module-call-names.js";
import { TRUE, type Condition } from "./presence-condition.js";
import { samePattern, patternText } from "./reference-reach.js";
import { escapingUses, extendsZone, providingSlots } from "./resolve-zone-containment.js";
import { definitionResolver } from "./resolve-zone-requirements.js";
import { isStepSlot } from "./step-slot.js";
import type { AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type DeadFinding, type PassTable } from "./union-passes.js";
import type { DeadBranchRun } from "./world-reader.js";
import { effectiveAuthorSchema, effectiveContractField } from "./extends-resolution.js";
import { valueDerivedSlot } from "./value-derived-contract.js";
import {
  contractRequiredDiagnostic,
  detachDiagnostic,
  impureCalls,
  isLiveSchema,
  nondeterminismDiagnostic,
  unjournalableDiagnostic,
} from "./validate-durable-regions.js";
import {
  owned,
  retryViolationDiagnostic,
  suspendingBackoff,
  violationDiagnostic,
} from "./validate-zone-violations.js";
import { readProvidesZone, readViolatesZone } from "./zone-slot.js";

type Keys = readonly (string | number)[];

/** The derived flags of what a module call reaches, written in `caller`'s module. */
export type ModuleCallFlags = (caller: ResourceManifest, qualified: string) => CallableFlags | undefined;

export interface ZoneRegionInputs {
  readonly graph: ConditionedCallGraph;
  readonly union: ConditionedExpansion;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly universe: Condition;
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  /** Where each function holds and each choice inside one is taken. */
  readonly callableConditions: readonly Condition[];
  /** The module-call flags of the functions holding at `witness`. */
  readonly flagsAt: (witness: World) => ModuleCallFlags;
  /** The branches no configuration takes, each walked once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** One hop of the route to a contained node. */
type Hop =
  | { readonly step: string }
  | { readonly slot: string; readonly toName: string; readonly target: string };

interface Contained<T> {
  readonly id: string;
  readonly via: readonly Hop[];
  readonly held: T;
}

interface Boundary<T> {
  readonly edge: HeldGraphEdge;
  readonly via: readonly Hop[];
  readonly escaping: readonly string[];
  readonly held: T;
}

interface Region<T> {
  readonly provider: HeldGraphNode;
  readonly slot: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly contents: readonly Contained<T>[];
  readonly boundaries: readonly Boundary<T>[];
}

interface RegionWorld<T> extends GraphWorld<T> {
  option(option: AlternativeOption): T;
  /** The module-call flags, each reading of the varying functions with where it holds. */
  flags(): readonly { readonly flags: ModuleCallFlags; readonly held: T }[];
}

interface Found<T> {
  readonly held: T;
  render(read: ChoiceDecider): AnalysisDiagnostic;
}

const moduleOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

export interface ZoneRegionTables {
  readonly violations: PassTable;
  readonly durable: PassTable;
}

export function zoneRegionFindings(inputs: ZoneRegionInputs): ZoneRegionTables {
  const { graph, union, defs, aliases, aliasesByModule, rootModules, universe, moduleCallNames } = inputs;
  const { space } = union;
  const resolveDef = definitionResolver(defs, aliases, aliasesByModule);
  const resourceOf = (id: string): ResourceGraphNode => graph.node(id)!.node as ResourceGraphNode;

  // Every resource node, in the order a run's graph lists them: module scope,
  // then scope members by holder and where each is written.
  const scoped = graph.nodes
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
  const resources = [...graph.resourceNodes().flatMap((n) => graph.readingsOf(n.id).filter((r) => !r.site)), ...scoped];

  /** The value at `keys` of `node`'s declaration, its own options taken on the
   *  way; a choice at the last key is returned as written. */
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

  const hopText = (hop: Hop, read: ChoiceDecider): string => {
    if ("step" in hop) {
      const step = graph.node(hop.step)!;
      const node = step.node as StepGraphNode;
      return node.name ? `step '${node.name}'` : graph.relativePathBy(step.owner!, step.keys, read);
    }
    const target = graph.node(hop.target)!.node;
    return `${hop.slot} → ${target.type === "resource" ? shownDeclaration(target.kind, hop.toName, target.manifest) : hop.toName}`;
  };
  const viaText = (via: readonly Hop[], read: ChoiceDecider): string[] => via.map((hop) => hopText(hop, read));
  const stepHop = (step: HeldGraphNode): Hop => ({ step: step.id });

  function regionsIn<T>(world: RegionWorld<T>): Region<T>[] {
    const L = world.logic;
    const out: Region<T>[] = [];
    for (const node of resources) {
      const resource = node.node as ResourceGraphNode;
      const schema = resolveDef(resource.kind, moduleOf(resource.manifest))?.schema as Record<string, any> | undefined;
      if (!schema) continue;
      const held = world.at(node);
      if (L.isFalse(held)) continue;
      for (const [slotKeys, slotSchema] of providingSlots(schema)) {
        const provides = readProvidesZone(slotSchema);
        if (!provides) continue;
        const slot = patternText(slotKeys);
        const entries: Contained<T>[] = [];
        if (isStepSlot(slotSchema)) {
          for (const step of graph.stepsOf(node.id)) {
            const array = (step.node as StepGraphNode).array;
            if (array === slot || array.startsWith(`${slot}[`)) entries.push({ id: step.id, via: [stepHop(step)], held: L.and(held, world.at(step)) });
          }
        } else {
          for (const edge of graph.edgesFrom(node.id)) {
            const matches = edge.edge.slotKeys ? samePattern(edge.edge.slotKeys, slotKeys) : edge.edge.slot === slot;
            if (!matches) continue;
            for (const target of world.targets(edge)) {
              if (target.to === undefined || !graph.node(target.to)) continue;
              entries.push({ id: target.to, via: [{ slot, toName: edge.edge.toName, target: target.to }], held: L.and(held, target.held) });
            }
          }
        }
        const { contents, boundaries } = collect(world, entries);
        out.push({ provider: node, slot, attributes: provides.attributes as Readonly<Record<string, string>>, contents, boundaries });
      }
    }
    return out;
  }

  /** The walk down from a region's entries: each node at its first route. */
  function collect<T>(world: RegionWorld<T>, entries: readonly Contained<T>[]): { contents: Contained<T>[]; boundaries: Boundary<T>[] } {
    const L = world.logic;
    const contents: Contained<T>[] = [];
    const boundaries: Boundary<T>[] = [];
    const visited = new Map<string, T>();
    const queue = [...entries];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const prior = visited.get(current.id) ?? L.FALSE;
      const held = L.and(current.held, L.not(prior));
      if (L.isFalse(held)) continue;
      visited.set(current.id, L.or(prior, held));
      contents.push({ id: current.id, via: current.via, held });
      const node = graph.node(current.id)!;
      reportKeyCost({ kind: "pass-reading", pass: "zoneRegions", declaration: node.declaration });
      if (node.node.type === "resource") {
        for (const step of graph.stepsOf(current.id)) {
          queue.push({ id: step.id, via: [...current.via, stepHop(step)], held: L.and(held, world.at(step)) });
        }
      }
      for (const edge of graph.edgesFrom(current.id)) {
        if (edge.edge.use.every((u) => u === "dependency" || u === "schema")) continue;
        if (!extendsZone(edge.edge)) {
          const escaping = escapingUses(edge.edge);
          const at = L.and(held, world.at(edge));
          if (escaping.length > 0 && !L.isFalse(at)) boundaries.push({ edge, via: current.via, escaping, held: at });
          continue;
        }
        for (const target of world.targets(edge)) {
          if (target.to === undefined || !graph.node(target.to)) continue;
          const at = L.and(held, target.held);
          if (L.isFalse(at)) continue;
          queue.push({ id: target.to, via: [...current.via, { slot: edge.edge.slot, toName: edge.edge.toName, target: target.to }], held: at });
        }
      }
    }
    return { contents, boundaries };
  }

  /** Each way `value` is written where `held` holds, every choice inside it taken. */
  function projections<T>(world: RegionWorld<T>, value: unknown, held: T): { value: unknown; held: T }[] {
    const L = world.logic;
    if (isAlternatives(value)) {
      return value.options.flatMap((option) => {
        const at = L.and(held, world.option(option));
        if (L.isFalse(at)) return [];
        return option.present ? projections(world, option.value, at) : [{ value: undefined, held: at }];
      });
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) return [{ value, held }];
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
    let partial: { value: unknown; held: T }[] = [{ value: Array.isArray(value) ? [] : {}, held }];
    for (const [key, member] of entries) {
      partial = partial.flatMap((p) =>
        projections(world, member, p.held).map((m) => {
          const next = Array.isArray(p.value) ? [...p.value] : { ...(p.value as Record<string, unknown>) };
          if (m.value === undefined && !Array.isArray(next)) delete (next as Record<string, unknown>)[key as string];
          else (next as Record<string | number, unknown>)[key] = m.value;
          return { value: next, held: m.held };
        }),
      );
    }
    return partial;
  }

  /** Each way `value` is written where `held` holds, its own choices taken and
   *  any inside it left as written. */
  function writings<T>(world: RegionWorld<T>, value: unknown, held: T): { value: unknown; held: T }[] {
    const L = world.logic;
    if (!isAlternatives(value)) return [{ value, held }];
    return value.options.flatMap((option) => {
      const at = L.and(held, world.option(option));
      if (L.isFalse(at)) return [];
      return option.present ? writings(world, option.value, at) : [{ value: undefined, held: at }];
    });
  }

  /** The kind-level facts `DURABLE_CONTRACT_REQUIRED` reads, per kind and module:
   *  undefined where the kind declares a contract or resolves to no definition. */
  const contractFreeKinds = new Map<string, { slot: string[] | undefined; takesOutputType: boolean } | undefined>();
  const contractFreeKind = (kind: string, module: string | undefined) => {
    const key = `${module ?? ""}\0${kind}`;
    if (contractFreeKinds.has(key)) return contractFreeKinds.get(key);
    const def = resolveDef(kind, module);
    const resolveKind = (k: string, from?: { metadata?: unknown }) => resolveDef(k, (from?.metadata as { module?: string } | undefined)?.module);
    let facts: { slot: string[] | undefined; takesOutputType: boolean } | undefined;
    if (def) {
      const declared = effectiveContractField(def, resolveKind, "outputType");
      if (declared === undefined || declared === null) {
        const authorSchema = effectiveAuthorSchema(def, resolveKind);
        facts = {
          slot: valueDerivedSlot(authorSchema, "outputType"),
          takesOutputType: Boolean((authorSchema.properties as Record<string, unknown> | undefined)?.outputType),
        };
      }
    }
    contractFreeKinds.set(key, facts);
    return facts;
  };

  /** Every CEL source a contained node holds, where it is written: a resource's
   *  whole value, a step's own, never a nested declaration's. */
  function celLeaves<T>(world: RegionWorld<T>, node: HeldGraphNode, held: T): { keys: Keys; source: string; held: T }[] {
    const L = world.logic;
    const out: { keys: Keys; source: string; held: T }[] = [];
    const step = node.node.type === "step";
    const walk = (value: unknown, keys: Keys, at: T): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          const taken = L.and(at, world.option(option));
          if (option.present && !L.isFalse(taken)) walk(option.value, keys, taken);
        }
        return;
      }
      if (!value || typeof value !== "object") return;
      if (isTaggedSentinel(value)) {
        for (const expression of celExpressionsOf(value.engine, value.source)) out.push({ keys, source: expression, held: at });
        return;
      }
      if (isCompiledValue(value)) {
        if (typeof value.source === "string") out.push({ keys, source: value.source, held: at });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, [...keys, i], at));
        return;
      }
      const record = value as Record<string, unknown>;
      if ((step || keys.length > node.keys.length) && typeof record.kind === "string") return;
      for (const [key, child] of Object.entries(record)) {
        if (key === "kind" || key === "metadata") continue;
        walk(child, [...keys, key], at);
      }
    };
    walk(rawAt(node, node.keys), node.keys, held);
    return out;
  }

  function violationsIn<T>(world: RegionWorld<T>, regions: readonly Region<T>[]): Found<T>[] {
    const L = world.logic;
    const found: Found<T>[] = [];
    const reported = new Map<string, T>();
    const once = (key: string, held: T): T => {
      const prior = reported.get(key) ?? L.FALSE;
      const at = L.and(held, L.not(prior));
      if (!L.isFalse(at)) reported.set(key, L.or(prior, at));
      return at;
    };
    const violationsOf = new Map<string, Record<string, string>>();
    const violations = (kind: string, module: string | undefined): Record<string, string> => {
      const key = `${module ?? ""}\0${kind}`;
      let known = violationsOf.get(key);
      if (!known) violationsOf.set(key, (known = readViolatesZone(resolveDef(kind, module)?.schema as Record<string, any> | undefined)));
      return known;
    };
    for (const attribute of ZONE_ATTRIBUTES.keys()) {
      for (const region of regions) {
        const reason = region.attributes[attribute];
        if (typeof reason !== "string") continue;
        const provider = resourceOf(region.provider.id);
        for (const contained of region.contents) {
          const node = graph.node(contained.id)!;
          if (attribute === "noSuspend" && node.node.type === "step") {
            const step = node.node as StepGraphNode;
            const owner = node.owner !== undefined ? graph.node(node.owner) : undefined;
            if (owner && owner.node.type === "resource" && owned((owner.node as ResourceGraphNode).manifest, rootModules)) {
              for (const policy of projections(world, rawAt(node, [...node.keys, "retry"]), contained.held)) {
                if (!suspendingBackoff(policy.value)) continue;
                const at = once(`retry\0${contained.id}`, policy.held);
                if (L.isFalse(at)) continue;
                found.push({
                  held: at,
                  render: (read) => {
                    const ownerIdentity = graph.identityBy(owner.id, read);
                    const path = graph.relativePathBy(owner.id, node.keys, read);
                    return aboutDeclaration(
                      retryViolationDiagnostic({
                        step: step.name ?? path,
                        path,
                        owner: ownerIdentity,
                        provider: graph.identityBy(region.provider.id, read),
                        reason,
                      }),
                      owner.id,
                    );
                  },
                });
              }
            }
          }
          if (node.node.type !== "resource") continue;
          const resource = node.node as ResourceGraphNode;
          const rebuttal = violations(resource.kind, moduleOf(resource.manifest))[attribute];
          if (!rebuttal || !owned(resource.manifest, rootModules)) continue;
          const at = once(`${region.provider.id}\0${region.slot}\0${contained.id}\0${attribute}`, contained.held);
          if (L.isFalse(at)) continue;
          found.push({
            held: at,
            render: (read) => {
              const identity = graph.identityBy(contained.id, read);
              const providerIdentity = graph.identityBy(region.provider.id, read);
              return aboutDeclaration(
                violationDiagnostic({
                  contained: { kind: resource.kind, name: identity.name, manifest: identity.manifest },
                  provider: { kind: provider.kind, name: providerIdentity.name, manifest: providerIdentity.manifest },
                  attribute,
                  reason,
                  rebuttal,
                  path: [`${providerIdentity.name}.${region.slot}`, ...viaText(contained.via, read)].join(" → "),
                }),
                contained.id,
              );
            },
          });
        }
      }
    }
    return found;
  }

  function durableIn<T>(world: RegionWorld<T>, regions: readonly Region<T>[]): Found<T>[] {
    const L = world.logic;
    const found: Found<T>[] = [];
    const collapsed = new Map<string, T>();
    for (const region of regions) {
      if (typeof region.attributes.idempotent !== "string") continue;
      for (const contained of region.contents) collapsed.set(contained.id, L.or(collapsed.get(contained.id) ?? L.FALSE, contained.held));
    }
    for (const region of regions) {
      if (typeof region.attributes.replayed !== "string") continue;
      const provider = region.provider.id;
      for (const boundary of region.boundaries) {
        if (!boundary.escaping.includes("detached")) continue;
        const from = resourceOf(boundary.edge.owner);
        if (!owned(from.manifest, rootModules)) continue;
        found.push({
          held: boundary.held,
          render: (read) =>
            aboutDeclaration(
              detachDiagnostic({
                from: graph.identityBy(boundary.edge.owner, read),
                slot: boundary.edge.edge.slot,
                path: graph.relativePathBy(boundary.edge.owner, boundary.edge.keys, read),
                provider: graph.identityBy(provider, read),
              }),
              boundary.edge.owner,
            ),
        });
      }
      for (const contained of region.contents) {
        const node = graph.node(contained.id)!;
        if (node.node.type !== "step") continue;
        const step = node.node as StepGraphNode;
        // A step inside an idempotent region has no entry of its own.
        const journaled = L.and(contained.held, L.not(collapsed.get(contained.id) ?? L.FALSE));
        for (const edge of L.isFalse(journaled) ? [] : graph.edgesFrom(contained.id)) {
          for (const target of world.targets(edge)) {
            if (target.to === undefined) continue;
            const targetNode = graph.node(target.to);
            if (!targetNode || targetNode.node.type !== "resource") continue;
            const resource = targetNode.node as ResourceGraphNode;
            const kind = contractFreeKind(resource.kind, moduleOf(resource.manifest));
            if (!kind) continue;
            const owner = node.owner !== undefined ? graph.node(node.owner) : undefined;
            const manifest = owner?.node.type === "resource" ? (owner.node as ResourceGraphNode).manifest : resource.manifest;
            if (!owned(manifest, rootModules)) continue;
            const at = L.and(journaled, target.held);
            if (L.isFalse(at)) continue;
            for (const own of writings(world, rawAt(targetNode, [...targetNode.keys, "outputType"]), at)) {
              if (own.value !== undefined && own.value !== null) continue;
              const derived = kind.slot ? writings(world, rawAt(targetNode, [...targetNode.keys, ...kind.slot]), own.held) : [{ value: undefined, held: own.held }];
              for (const value of derived) {
                const v = value.value;
                if (v && typeof v === "object" && !Array.isArray(v) && !isTaggedSentinel(v)) continue;
                found.push({
                  held: value.held,
                  render: (read) => {
                    const ownerId = owner?.node.type === "resource" ? owner.id : target.to!;
                    const path = graph.relativePathBy(ownerId, node.keys, read);
                    return aboutDeclaration(
                      contractRequiredDiagnostic({
                        step: step.name ?? path,
                        path,
                        target: graph.identityBy(target.to!, read),
                        provider: graph.identityBy(provider, read),
                        anchor: graph.identityBy(ownerId, read),
                        takesOutputType: kind.takesOutputType,
                      }),
                      ownerId,
                    );
                  },
                });
              }
            }
          }
        }
        for (const edge of graph.edgesFrom(contained.id)) {
          for (const target of world.targets(edge)) {
            if (target.to === undefined) continue;
            const targetNode = graph.node(target.to);
            if (!targetNode || targetNode.node.type !== "resource") continue;
            const resource = targetNode.node as ResourceGraphNode;
            const kindOutput = (resolveDef(resource.kind, moduleOf(resource.manifest)) as Record<string, unknown> | undefined)?.outputType;
            const owner = node.owner !== undefined ? graph.node(node.owner) : undefined;
            const manifest = owner?.node.type === "resource" ? (owner.node as ResourceGraphNode).manifest : resource.manifest;
            if (!owned(manifest, rootModules)) continue;
            const at = L.and(contained.held, target.held);
            if (L.isFalse(at)) continue;
            for (const declared of projections(world, rawAt(targetNode, [...targetNode.keys, "outputType"]), at)) {
              if (!isLiveSchema(declared.value ?? kindOutput)) continue;
              found.push({
                held: declared.held,
                render: (read) => {
                  const ownerId = owner?.node.type === "resource" ? owner.id : target.to!;
                  const path = graph.relativePathBy(ownerId, node.keys, read);
                  return aboutDeclaration(
                    unjournalableDiagnostic({
                      step: step.name ?? path,
                      path,
                      target: graph.identityBy(target.to!, read),
                      provider: graph.identityBy(provider, read),
                      anchor: graph.identityBy(ownerId, read),
                    }),
                    ownerId,
                  );
                },
              });
            }
          }
        }
      }
    }
    for (const region of regions) {
      const reason = region.attributes.idempotent;
      if (typeof reason !== "string") continue;
      const provider = region.provider.id;
      for (const contained of region.contents) {
        const node = graph.node(contained.id)!;
        const anchorId = node.node.type === "resource" ? node.id : node.owner;
        const anchor = anchorId !== undefined ? graph.node(anchorId) : undefined;
        if (!anchor || anchor.node.type !== "resource") continue;
        const manifest = (anchor.node as ResourceGraphNode).manifest;
        if (!owned(manifest, rootModules)) continue;
        const names = moduleCallNamesOf(moduleCallNames, manifest);
        for (const leaf of celLeaves(world, node, contained.held)) {
          for (const reading of world.flags()) {
            const at = L.and(leaf.held, reading.held);
            if (L.isFalse(at)) continue;
            const fn = impureCalls(leaf.source, names, (qualified) => reading.flags(manifest, qualified))[0];
            if (fn === undefined) continue;
            found.push({
              held: at,
              render: (read) =>
                aboutDeclaration(
                  nondeterminismDiagnostic({
                    fn,
                    provider: graph.identityBy(provider, read),
                    reason,
                    anchor: graph.identityBy(anchor.id, read),
                    path: graph.relativePathBy(anchor.id, leaf.keys, read),
                  }),
                  anchor.id,
                ),
            });
          }
        }
      }
    }
    return found;
  }

  // The module-call flags over every configuration: one reading where no
  // function varies, else one per class of the varying functions' conditions.
  let flagReadings: { flags: ModuleCallFlags; held: Condition }[] | undefined;
  const conditionWorld: RegionWorld<Condition> = {
    ...graph.conditionWorld(),
    option: (option) => option.condition,
    flags: () =>
      (flagReadings ??= readingsOf(space, [TRUE, ...inputs.callableConditions], universe).map((reading) => ({
        flags: inputs.flagsAt(World.key(space.firstAssignment(reading.held)!)),
        held: reading.held,
      }))),
  };
  const regions = regionsIn(conditionWorld);
  const violations = violationsIn(conditionWorld, regions);
  const durable = durableIn(conditionWorld, regions);

  // Each branch no configuration takes, walked once.
  const deadWorlds = new Map(inputs.deadBranches.map((branch) => {
    const witness: World = branch.world;
    let flags: ModuleCallFlags | undefined;
    const world: RegionWorld<boolean> = {
      ...graph.witnessWorld(witness),
      option: (option) => takenAt(space, option.condition, option.path, witness.assignment, witness.forcing),
      flags: () => [{ flags: (flags ??= inputs.flagsAt(witness)), held: true }],
    };
    return [branch, { world, regions: regionsIn(world) }] as const;
  }));
  const table = (
    pass: "zoneViolations" | "durableRegions",
    entries: readonly Found<Condition>[],
    dead: (world: RegionWorld<boolean>, regions: readonly Region<boolean>[]) => Found<boolean>[],
  ): PassTable => ({
    found: entries.map((entry) => ({ held: entry.held, render: (read) => [entry.render(read)] })),
    dead: readDeadBranches(pass, inputs.deadBranches, (branch): DeadFinding[] => {
      const { world, regions } = deadWorlds.get(branch)!;
      return dead(world, regions).map((entry) => ({ branch, render: (read) => [entry.render(read)] }));
    }),
  });
  return {
    violations: table("zoneViolations", violations, (world, regions) => violationsIn(world, regions)),
    durable: table("durableRegions", durable, (world, regions) => durableIn(world, regions)),
  };
}

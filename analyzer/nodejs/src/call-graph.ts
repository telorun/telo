/**
 * The typed reference graph — one model of "what calls what", replacing the
 * private walkers each analysis used to build for itself.
 *
 * **Two node kinds.** Resource nodes carry their declaration-site identity. Step
 * nodes carry name, lexical order, enclosing array and nesting parent, and
 * *optionally* an outgoing edge. Steps are nodes rather than edge decorations
 * because a pure `value:` step produces `steps.<name>.result` while referencing
 * nothing — it has no edge to hang on — and because step identity, ordering and
 * nesting are exactly what `steps.<name>.result` typing, per-step throws
 * coverage and the editor's step rendering consume.
 *
 * **Lexical order and containment, not execution order.** Order is the written
 * order of the array; which branch actually runs is decided by runtime
 * predicates and is not statically derivable. That is sufficient by
 * construction: result typing needs step names, throws coverage needs
 * `try` / `catch` containment rather than which arm fires, and the editor
 * renders rows as written.
 *
 * **Edges are `(from, slot, to, use)` and the graph is a MULTIGRAPH.** The slot
 * path is part of an edge's identity, so a kind declaring several ref slots
 * emits one edge per slot, each with its own `use` — `Cache.View` holds its
 * `store:` as a `dependency` while its `invoke:` is a `call` — and two slots may
 * name the same target without collapsing. Array slots emit one edge per
 * element. This is a requirement, not a detail: the old `dependency-graph.ts`
 * kept a set-valued adjacency map, which erases parallel edges and would
 * silently merge a dependency with a call. The init-order consumer projects the
 * multigraph down to unique pairs itself, since that is the only consumer for
 * which the distinction genuinely does not matter.
 *
 * **Three discovery mechanics, one graph.** Field-map sites (Phase-5 injection
 * sites — `edge.injected`), schema-driven step slots behind the local `$ref`s
 * the field map deliberately does not descend, and a value-tree scan for `!ref`
 * anywhere else — so a ref in a structure no annotation anticipated is still an
 * edge (with no declared `use`, read conservatively). Inline declarations
 * inside `x-telo-scope` arrays become nodes of their own and their slots are
 * walked, so a `with:`-scoped resource's references are part of the one model.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  enclosingOf,
  propertySchemas,
  resolveLocalRef,
} from "./manifest-navigation.js";
import { visitManifest } from "./manifest-visitor.js";
import {
  possibleUses,
  readRefSlot,
  transfersControl,
  type RefUse,
  type RefUseCases,
} from "./ref-slot.js";
import { isStepSlot } from "./step-slot.js";
import { isRefEntry, resolveFieldEntries, type RefFieldEntry } from "./reference-field-map.js";
import { DEPENDENCY_GRAPH_SKIP_KINDS as SYSTEM_KINDS } from "./system-kinds.js";

export interface ResourceGraphNode {
  type: "resource";
  id: string;
  kind: string;
  name: string;
  manifest: ResourceManifest;
  /** Declared inside another resource's `x-telo-scope` array: created when the
   *  scope opens rather than at boot, so it takes no part in init ordering. Its
   *  declaration-site identity is the scope site, never the module. */
  scoped?: boolean;
  /** Node id of the resource whose scope declares this one (set iff `scoped`). */
  scopeOwner?: string;
  /** The scope field's JSON Pointer on the owner (set iff `scoped`). */
  scopeSite?: string;
}

export interface StepGraphNode {
  type: "step";
  id: string;
  /** The step's declared `name:`, when it has one. */
  name?: string;
  /** Node id of the resource whose body declares this step. */
  owner: string;
  /** Concrete path within the owner (`steps[0].do[1]`). */
  path: string;
  /** Concrete path of the enclosing step array (`steps`, `steps[0].do`). */
  array: string;
  /** Enclosing step node, when this step nests inside another's branch. */
  parent?: string;
  /** Lexical index within its own array. */
  index: number;
  /** The step value as written. */
  step: Record<string, unknown>;
}

export type CallGraphNode = ResourceGraphNode | StepGraphNode;

export interface CallGraphEdge {
  /** Node id of the resource or step that declares the slot. */
  from: string;
  /** The referenced resource's NAME, always present — including when no node
   *  carries it. A `!ref` to a name that does not exist is a real edge some
   *  other validator reports; dropping it would make the graph disagree with
   *  the manifest about what was written. */
  toName: string;
  /** Node id of the target, when the name resolves to one. A name declared in
   *  the source's own scope resolves to the SCOPED node (scope-local first, the
   *  order `ScopeContext` and `!ref` already agree on), never to a same-named
   *  module-level resource. */
  to?: string;
  /** Field-map path of the slot — part of the edge's identity. */
  slot: string;
  /** Concrete path of this site (`routes[2].handler`). */
  path: string;
  /**
   * What the declaring resource does with the target at this site. Resolved
   * against a case map's selector when the graph could read it; otherwise every
   * use the slot could take (see {@link CallGraphEdge.unresolved}).
   */
  use: RefUse[];
  /** Set when a case map's selector could not be resolved statically, so `use`
   *  is the union of the map's cases rather than the one that holds. */
  unresolved?: RefUseCases;
  /** Why the selector did not resolve: written in CEL (`dynamic` — a
   *  diagnostic, see `validate-ref-slots.ts`), absent with no schema default
   *  (`absent`), or a literal matching no case (`unmatched`). */
  unresolvedReason?: "dynamic" | "absent" | "unmatched";
  /** JSON Pointer to the field carrying this call's arguments, when declared. */
  inputs?: string;
  /** This site is a Phase-5 injection site — the reference field map reaches
   *  it, so the kernel puts the live instance into the field before `init()`.
   *  THE init-order criterion: injection is what forces construct-before-use,
   *  regardless of whether the slot is declared at resource level or inside an
   *  inline step array (`Telo.Application.targets`). Step slots behind a local
   *  `$ref` and value-tree-discovered refs are not injection sites — those
   *  resolve at dispatch. */
  injected?: boolean;
  /** Found by the value-tree scan rather than a declared slot — no schema, no
   *  declared `use` (read conservatively as control-transferring). */
  nested?: boolean;
  /** The target is declared INSIDE the source's own `x-telo-scope`, so it is
   *  created on demand when the scope opens rather than at boot. Recorded rather
   *  than dropped: it is a real edge, and only the init-order consumer wants it
   *  gone. */
  scoped?: boolean;
}

export interface CallGraph {
  nodes: ReadonlyMap<string, CallGraphNode>;
  edges: readonly CallGraphEdge[];
  /** Edges leaving a node, in declaration order. */
  edgesFrom(id: string): CallGraphEdge[];
  /** Edges arriving at a resource node. */
  edgesTo(id: string): CallGraphEdge[];
  resource(kind: string, name: string): ResourceGraphNode | undefined;
  resourceByName(name: string): ResourceGraphNode | undefined;
  /** Step nodes declared by a resource, in lexical order. */
  steps(resourceId: string): StepGraphNode[];
  /** Every edge whose `use` includes at least one control transfer, plus every
   *  edge whose slot declares no `use` at all — see {@link CallGraph.controlEdges}. */
  controlEdges(): CallGraphEdge[];
}

export const resourceId = (kind: string, name: string): string => `${kind}\0${name}`;

/**
 * Does control reach this edge's target?
 *
 * An edge whose slot declares NO use — the bare-string form, still accepted
 * while the ecosystem migrates, and every value-tree-discovered ref — counts as
 * control-transferring. That is the conservative direction for every consumer
 * of this predicate: the cost of a false "control reaches here" is a check that
 * stays silent, while the cost of a false "it never does" is a valid manifest
 * rejected. It is also exactly what the walkers this replaced did, so an
 * unannotated third-party kind behaves as it did before. The branch disappears
 * when `use` becomes mandatory.
 */
function reachesTarget(edge: CallGraphEdge): boolean {
  return edge.use.length === 0 || edge.use.some(transfersControl);
}

/** Navigate a JSON Pointer relative to the object enclosing the annotated slot.
 *
 *  One rule serves a resource-level sibling and an array item's sibling, and
 *  nothing can address across an array boundary — if a case for root anchoring
 *  ever appears it gets its own spelling, the split `x-telo-context-from` /
 *  `x-telo-context-from-root` already make. */
function navigatePointer(enclosing: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = enclosing;
  for (const rawSegment of pointer.slice(1).split("/")) {
    if (current == null || typeof current !== "object") return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = Array.isArray(current)
      ? (current as unknown[])[Number(segment)]
      : (current as Record<string, unknown>)[segment];
  }
  return current;
}

type SchemaDefault = (pointer: string) => unknown;

const NO_DEFAULT: SchemaDefault = () => undefined;

/** Schema-declared `default:` for a selector pointer, resolved against the
 *  schema of the object ENCLOSING the annotated slot — the same anchoring the
 *  runtime value walk uses. This is what classifies the common spelling: a
 *  `Lease.Critical` that omits `detach:` takes the schema's `default: false`
 *  and is a `call` edge, not an unresolved one. */
function schemaDefaultOf(enclosingSchema: Record<string, any> | undefined): SchemaDefault {
  if (!enclosingSchema) return NO_DEFAULT;
  return (pointer) => {
    if (!pointer.startsWith("/")) return undefined;
    let current: Record<string, any> | undefined = enclosingSchema;
    let value: unknown;
    for (const rawSegment of pointer.slice(1).split("/")) {
      if (!current) return undefined;
      const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
      const next: Record<string, any> | undefined = propertySchemas(current).find(
        ([k]) => k === segment,
      )?.[1];
      if (!next) return undefined;
      value = next.default;
      current = next;
    }
    return value;
  };
}

/** The schema node describing the object that ENCLOSES a slot, from the slot's
 *  field-map path (`routes[].handler` → `routes`' item schema). Follows `[]`
 *  into `items` and `{}` into `additionalProperties`, resolving local `$ref`s. */
function enclosingSchemaOf(
  rootSchema: Record<string, any>,
  slotFieldPath: string,
): Record<string, any> | undefined {
  const segments = slotFieldPath.split(".");
  segments.pop(); // the slot itself — we want its parent object
  let current: Record<string, any> | undefined = rootSchema;
  for (const segment of segments) {
    if (!current) return undefined;
    const bare = segment.replace(/(\[\]|\{\})+$/g, "");
    let next: Record<string, any> | undefined = propertySchemas(current).find(
      ([k]) => k === bare,
    )?.[1];
    if (!next) return undefined;
    for (const marker of segment.slice(bare.length).match(/\[\]|\{\}/g) ?? []) {
      next =
        marker === "[]"
          ? (next?.items as Record<string, any> | undefined)
          : (next?.additionalProperties as Record<string, any> | undefined);
      next = resolveLocalRef(next, rootSchema);
      if (!next || typeof next !== "object") return undefined;
    }
    current = resolveLocalRef(next, rootSchema);
  }
  return current;
}

/**
 * Resolve a slot's declared use at one concrete site.
 *
 * A case map's selector must be statically resolvable — a literal or a schema
 * default. There is deliberately no fallback: no single value is conservative
 * for every consumer, since the throws union must assume `call` to keep an error
 * path and a zone requirement must assume the opposite to avoid inventing one.
 * When the selector cannot be read the edge reports every case's use AND says
 * why (`unresolvedReason`), so a consumer chooses its own reading — and
 * `validate-ref-slots.ts` turns the `dynamic` reason into a diagnostic, because
 * a call graph known only at runtime is not statically analyzable.
 */
function resolveUseAtSite(
  entry: RefFieldEntry,
  root: unknown,
  concretePath: string,
  schemaDefault: SchemaDefault,
): Pick<CallGraphEdge, "use" | "unresolved" | "unresolvedReason"> {
  if (!entry.useCases) return { use: entry.uses };
  const enclosing = enclosingOf(root, concretePath);
  let selector = navigatePointer(enclosing, entry.useCases.by);
  if (selector === undefined) selector = schemaDefault(entry.useCases.by);
  if (selector !== undefined && typeof selector !== "object") {
    const resolved = entry.useCases.cases[String(selector)];
    if (resolved) return { use: resolved };
  }
  const slot = {
    kinds: entry.refs,
    uses: entry.uses,
    useCases: entry.useCases,
    inline: false,
    valueBranches: [],
  };
  const unresolvedReason = isTaggedSentinel(selector)
    ? "dynamic"
    : selector === undefined
      ? "absent"
      : "unmatched";
  return { use: possibleUses(slot), unresolved: entry.useCases, unresolvedReason };
}

/** A resolved plain reference value (`{kind, name}`, optionally `alias`) — the
 *  shape `resolveRefSentinels` leaves at a ref site. NOT a step: a bare boot
 *  target written `!ref X` must not mint a step node. */
function isPlainRefValue(value: Record<string, unknown>): boolean {
  if (typeof value.kind !== "string" || typeof value.name !== "string") return false;
  return Object.keys(value).every((k) => k === "kind" || k === "name" || k === "alias" || k === "__ref");
}

interface StepWalkContext {
  owner: ResourceGraphNode;
  rootSchema: Record<string, any>;
  itemSchema: Record<string, any> | undefined;
  /** Field-map-style prefix for slots on a step of this list (`steps[]`). */
  slotPrefix: string;
  nodes: Map<string, CallGraphNode>;
  order: StepGraphNode[];
  resolveName: (name: string) => ResourceGraphNode | undefined;
  edges: CallGraphEdge[];
  /** `${ownerId}\0${concretePath}` → the edge a step slot emitted, so the
   *  field-map walk can stamp `injected` on sites it also reaches
   *  (`Telo.Application.targets`). */
  stepEdgesByPath: Map<string, CallGraphEdge>;
}

/**
 * Emit the edges a single step's own ref slots declare.
 *
 * Read from the step ITEM SCHEMA rather than from the reference field map: a
 * step array's items sit behind a local `$ref`, and the field map deliberately
 * does not descend one (descending it there would turn every step's `invoke`
 * into a Phase-5 injection site). The schema is already in hand here, so the
 * graph sees these slots at no cost to the kernel's injection surface.
 */
function emitStepEdges(node: StepGraphNode, ctx: StepWalkContext): void {
  if (!ctx.itemSchema) return;
  const schemaDefault = schemaDefaultOf(ctx.itemSchema);
  for (const [key, propSchema] of propertySchemas(ctx.itemSchema)) {
    const slot = readRefSlot(propSchema);
    if (!slot || slot.kinds.length === 0) continue;
    const targetName = refTargetName(node.step[key]);
    if (targetName === undefined) continue;
    const entry: RefFieldEntry = {
      refs: slot.kinds,
      uses: slot.uses,
      isArray: false,
      ...(slot.useCases ? { useCases: slot.useCases } : {}),
      ...(slot.inputs !== undefined ? { inputs: slot.inputs } : {}),
    };
    // The step itself is the enclosing object, so a `use` case map and an
    // `inputs` pointer both resolve against the step's own siblings.
    const { use, unresolved, unresolvedReason } = resolveUseAtSite(
      entry,
      node.step,
      key,
      schemaDefault,
    );
    const edge: CallGraphEdge = {
      from: node.id,
      toName: targetName,
      slot: `${ctx.slotPrefix}.${key}`,
      path: `${node.path}.${key}`,
      use,
    };
    const target = ctx.resolveName(targetName);
    if (target) edge.to = target.id;
    if (unresolved) edge.unresolved = unresolved;
    if (unresolvedReason) edge.unresolvedReason = unresolvedReason;
    if (slot.inputs !== undefined) edge.inputs = slot.inputs;
    ctx.edges.push(edge);
    ctx.stepEdgesByPath.set(`${node.owner}\0${edge.path}`, edge);
  }
}

/**
 * The single step-array recursion in the analyzer.
 *
 * A step's position is manifest data, never schema data: no definition declares
 * a next or previous step, and none needs to — order is the written order of the
 * array, and this is a manifest × schema co-traversal, so the array is in hand
 * exactly where step nodes are minted. The schema's whole contribution is to
 * mark an array as a step list and to name the fields that nest further steps
 * (`branch`, `branch-list`, `case-map`).
 */
function walkSteps(
  steps: unknown[],
  arrayPath: string,
  parent: string | undefined,
  ctx: StepWalkContext,
): void {
  const dispatchRole = (
    data: unknown,
    role: string,
    itemsSchema: Record<string, any> | undefined,
    path: string,
    stepId: string,
  ): void => {
    if (role === "branch" && Array.isArray(data)) {
      walkSteps(data, path, stepId, ctx);
    } else if (role === "case-map" && data && typeof data === "object" && !Array.isArray(data)) {
      for (const [caseKey, arr] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(arr)) walkSteps(arr, `${path}.${caseKey}`, stepId, ctx);
      }
    } else if (role === "branch-list" && Array.isArray(data)) {
      const entrySchema = resolveLocalRef(itemsSchema, ctx.rootSchema);
      if (!entrySchema) return;
      data.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") return;
        for (const [subKey, subSchema] of propertySchemas(entrySchema)) {
          const subRole = subSchema["x-telo-topology-role"];
          if (typeof subRole !== "string") continue;
          dispatchRole(
            (entry as Record<string, any>)[subKey],
            subRole,
            subSchema.items as Record<string, any> | undefined,
            `${path}[${i}].${subKey}`,
            stepId,
          );
        }
      });
    }
  };

  steps.forEach((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return;
    // A bare reference in a step position (`targets: [!ref X]`, or the resolved
    // `{kind, name}` it becomes) is a target, not a step — the field-map walk
    // owns that edge. Minting a node here would put ref noise in the step model.
    if (isRefSentinel(step)) return;
    const value = step as Record<string, unknown>;
    if (isPlainRefValue(value)) return;
    const path = `${arrayPath}[${index}]`;
    const id = `${ctx.owner.id}#${path}`;
    const node: StepGraphNode = {
      type: "step",
      id,
      owner: ctx.owner.id,
      path,
      array: arrayPath,
      index,
      step: value,
    };
    if (typeof value.name === "string") node.name = value.name;
    if (parent) node.parent = parent;
    ctx.nodes.set(id, node);
    ctx.order.push(node);
    emitStepEdges(node, ctx);

    if (!ctx.itemSchema) return;
    for (const [key, propSchema] of propertySchemas(ctx.itemSchema)) {
      const role = propSchema["x-telo-topology-role"];
      if (typeof role !== "string") continue;
      dispatchRole(
        value[key],
        role,
        propSchema.items as Record<string, any> | undefined,
        `${path}.${key}`,
        id,
      );
    }
  });
}

/** The concrete step path a nested site belongs to, or undefined for a
 *  resource-level site. Longest-prefix match, so a site inside `steps[0].do[1]`
 *  attaches to that step rather than to `steps[0]`. */
function ownerStepOf(steps: StepGraphNode[], concretePath: string): StepGraphNode | undefined {
  let best: StepGraphNode | undefined;
  for (const step of steps) {
    if (!concretePath.startsWith(`${step.path}.`)) continue;
    if (!best || step.path.length > best.path.length) best = step;
  }
  return best;
}

export interface BuildCallGraphOptions {
  aliases?: AliasResolver;
  aliasesByModule?: Map<string, AliasResolver>;
}

/**
 * Build the call graph for one manifest set.
 *
 * Reference discovery is three-fold. Field-map sites come from `visitManifest`
 * — the same walk the reference validators use — and are stamped `injected`,
 * because those and only those are Phase-5 injection sites. Step slots are read
 * from the step item schema, because they sit behind local `$ref`s the field
 * map deliberately does not descend. Everything else is caught by the value-
 * tree scan (`discoverNestedRefs`): a `!ref` is an explicit marker, so a ref in
 * a structure no annotation anticipated is still an edge — with no declared
 * `use`, read conservatively — instead of a blind spot. Inline declarations in
 * `x-telo-scope` arrays become scoped nodes with edges of their own.
 */
export function buildCallGraph(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  options: BuildCallGraphOptions = {},
): CallGraph {
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];
  const byName = new Map<string, ResourceGraphNode>();
  const stepsByOwner = new Map<string, StepGraphNode[]>();
  const stepEdgesByPath = new Map<string, CallGraphEdge>();

  /**
   * A resource's definition, resolved in the scope of the module that DECLARED
   * it. A manifest carries the kind as AUTHORED (`Run.Sequence`), while the
   * registry is keyed canonically (`run.Sequence`), so a raw lookup misses for
   * every alias-form kind — which is every kind in a real manifest. That miss
   * is silent and costly: step collection would find no step list (so a step's
   * declared `use` never reaches its edge, and the site degrades to an untyped
   * value-tree edge), and a case map's selector would find no schema `default`
   * (so a slot resolved by an omitted field reads as unresolved). Same scope
   * selection as `expandedFieldMapForResource`.
   */
  const definitionFor = (manifest: ResourceManifest): ResourceDefinition | undefined => {
    const direct = registry.resolve(manifest.kind as string);
    if (direct) return direct;
    const module = (manifest.metadata as { module?: string } | undefined)?.module;
    const scope = (module ? options.aliasesByModule?.get(module) : undefined) ?? options.aliases;
    const canonical = scope?.resolveKind(manifest.kind as string);
    return canonical ? registry.resolve(canonical) : undefined;
  };

  for (const manifest of resources) {
    const name = manifest.metadata?.name;
    if (!name || !manifest.kind || SYSTEM_KINDS.has(manifest.kind)) continue;
    const node: ResourceGraphNode = {
      type: "resource",
      id: resourceId(manifest.kind, name as string),
      kind: manifest.kind,
      name: name as string,
      manifest,
    };
    nodes.set(node.id, node);
    byName.set(node.name, node);
  }

  // --- step nodes ---
  const collectStepsFor = (
    node: ResourceGraphNode,
    resolveName: (name: string) => ResourceGraphNode | undefined,
  ): void => {
    const definition = definitionFor(node.manifest);
    const schema = definition?.schema as Record<string, any> | undefined;
    if (!schema) return;
    const collected: StepGraphNode[] = [];
    for (const [key, propSchema] of propertySchemas(schema)) {
      if (!isStepSlot(propSchema)) continue;
      const value = (node.manifest as Record<string, unknown>)[key];
      if (!Array.isArray(value)) continue;
      walkSteps(value, key, undefined, {
        owner: node,
        rootSchema: schema,
        itemSchema: resolveLocalRef(propSchema.items as Record<string, any>, schema),
        slotPrefix: `${key}[]`,
        nodes,
        order: collected,
        resolveName,
        edges,
        stepEdgesByPath,
      });
    }
    if (collected.length > 0) stepsByOwner.set(node.id, collected);
  };

  for (const node of [...nodes.values()] as ResourceGraphNode[]) {
    collectStepsFor(node, (name) => byName.get(name));
  }

  // --- edges ---
  // Scope-local nodes of the CURRENT resource. The visitor fires `onScope`
  // before that resource's ref sites, so both are set before any edge they
  // qualify is added. Scope-local names win over module-level ones — the order
  // `ScopeContext` and `!ref` already agree on.
  let scopedNames = new Set<string>();
  let scopeLocal = new Map<string, ResourceGraphNode>();

  const fieldMapFor = (manifest: ResourceManifest) => {
    if (options.aliases && options.aliasesByModule) {
      return registry.expandedFieldMapForResource(manifest, options.aliases, options.aliasesByModule);
    }
    if (options.aliases) return registry.getFieldMapForKind(manifest.kind, options.aliases);
    return registry.getFieldMap(manifest.kind);
  };

  visitManifest(
    resources,
    registry,
    {
      onScope: (event) => {
        scopedNames = event.enclosedNames;
        scopeLocal = new Map();
        const ownerName = event.source.metadata?.name as string | undefined;
        if (!ownerName || !event.source.kind) return;
        const ownerId = resourceId(event.source.kind, ownerName);

        // Inline declarations inside `x-telo-scope` arrays become nodes of
        // their own, keyed by their scope site — the declaration-site identity
        // the zones plan correlates on. They are excluded from init ordering
        // (created when the scope opens), but their own references are real
        // edges of the one model.
        for (const [pointer, manifests] of event.manifestsByPointer) {
          for (const manifest of manifests) {
            const name = manifest.metadata?.name;
            if (typeof name !== "string" || !manifest.kind) continue;
            const scopedNode: ResourceGraphNode = {
              type: "resource",
              id: `${ownerId}#${pointer}#${resourceId(manifest.kind, name)}`,
              kind: manifest.kind,
              name,
              manifest,
              scoped: true,
              scopeOwner: ownerId,
              scopeSite: pointer,
            };
            nodes.set(scopedNode.id, scopedNode);
            scopeLocal.set(name, scopedNode);
          }
        }
        if (scopeLocal.size === 0) return;

        const resolveScoped = (name: string): ResourceGraphNode | undefined =>
          scopeLocal.get(name) ?? byName.get(name);

        // The owner's own step edges were emitted before this scope was seen
        // (step collection precedes the visit), so their names resolved
        // module-level. Re-resolve them now that the scope exists: scope-local
        // names WIN — the order `ScopeContext` and `!ref` already agree on — so
        // a step's `invoke: !ref X` with X declared in `with:` reaches the
        // scoped node, never a same-named module-level shadow.
        for (const [key, edge] of stepEdgesByPath) {
          if (!key.startsWith(`${ownerId}\0`)) continue;
          const local = scopeLocal.get(edge.toName);
          if (!local) continue;
          edge.to = local.id;
          edge.scoped = true;
        }

        for (const scopedNode of scopeLocal.values()) {
          // The scoped resource's own ref slots, from its kind's field map.
          const fieldMap = fieldMapFor(scopedNode.manifest);
          if (fieldMap) {
            const definition = definitionFor(scopedNode.manifest);
            const rootSchema = definition?.schema as Record<string, any> | undefined;
            for (const [fieldPath, entry] of fieldMap) {
              if (!isRefEntry(entry)) continue;
              for (const { value, path } of resolveFieldEntries(scopedNode.manifest, fieldPath)) {
                const targetName = refTargetName(value);
                if (targetName === undefined) continue;
                const schemaDefault = rootSchema
                  ? schemaDefaultOf(enclosingSchemaOf(rootSchema, fieldPath))
                  : NO_DEFAULT;
                const { use, unresolved, unresolvedReason } = resolveUseAtSite(
                  entry,
                  scopedNode.manifest,
                  path,
                  schemaDefault,
                );
                const edge: CallGraphEdge = {
                  from: scopedNode.id,
                  toName: targetName,
                  slot: fieldPath,
                  path,
                  use,
                };
                const target = resolveScoped(targetName);
                if (target) edge.to = target.id;
                if (unresolved) edge.unresolved = unresolved;
                if (unresolvedReason) edge.unresolvedReason = unresolvedReason;
                if (entry.inputs !== undefined) edge.inputs = entry.inputs;
                edges.push(edge);
              }
            }
          }
          // Its step arrays too, resolved scope-local first.
          collectStepsFor(scopedNode, resolveScoped);
        }
      },
      onRef: (event) => {
        const sourceName = event.source.metadata?.name as string | undefined;
        if (!sourceName || !event.source.kind) return;
        const sourceId = resourceId(event.source.kind, sourceName);
        if (!nodes.has(sourceId)) return;

        // A site inside a step was already emitted by the step walk, which
        // reads the step item schema directly. When the FIELD MAP also reaches
        // it — `Telo.Application`'s inline `targets[].invoke`, unlike
        // `Run.Sequence`'s `$ref`-hidden `steps[].invoke` — the site is a
        // Phase-5 injection site, and the existing step edge is stamped so the
        // init-order projection keeps it.
        if (ownerStepOf(stepsByOwner.get(sourceId) ?? [], event.concretePath)) {
          if (!event.nested) {
            const stepEdge = stepEdgesByPath.get(`${sourceId}\0${event.concretePath}`);
            if (stepEdge) stepEdge.injected = true;
          }
          return;
        }

        const targetName = refTargetName(event.value);
        if (targetName === undefined) return;

        const definition = definitionFor(event.source);
        const rootSchema = definition?.schema as Record<string, any> | undefined;
        const schemaDefault =
          !event.nested && rootSchema
            ? schemaDefaultOf(enclosingSchemaOf(rootSchema, event.fieldPath))
            : NO_DEFAULT;
        const { use, unresolved, unresolvedReason } = resolveUseAtSite(
          event.entry,
          event.source,
          event.concretePath,
          schemaDefault,
        );
        const edge: CallGraphEdge = {
          from: sourceId,
          toName: targetName,
          slot: event.fieldPath,
          path: event.concretePath,
          use,
        };
        const target = scopedNames.has(targetName)
          ? (scopeLocal.get(targetName) ?? byName.get(targetName))
          : byName.get(targetName);
        if (target) edge.to = target.id;
        if (unresolved) edge.unresolved = unresolved;
        if (unresolvedReason) edge.unresolvedReason = unresolvedReason;
        if (event.entry.inputs !== undefined) edge.inputs = event.entry.inputs;
        if (event.nested) edge.nested = true;
        else edge.injected = true;
        if (scopedNames.has(targetName)) edge.scoped = true;
        edges.push(edge);
      },
    },
    {
      aliases: options.aliases,
      aliasesByModule: options.aliasesByModule,
      skipKinds: SYSTEM_KINDS,
      expand: true,
      discoverNestedRefs: true,
    },
  );

  const fromIndex = new Map<string, CallGraphEdge[]>();
  const toIndex = new Map<string, CallGraphEdge[]>();
  const push = (index: Map<string, CallGraphEdge[]>, key: string, edge: CallGraphEdge): void => {
    const bucket = index.get(key);
    if (bucket) bucket.push(edge);
    else index.set(key, [edge]);
  };
  for (const edge of edges) {
    push(fromIndex, edge.from, edge);
    if (edge.to) push(toIndex, edge.to, edge);
  }

  return {
    nodes,
    edges,
    edgesFrom: (id) => fromIndex.get(id) ?? [],
    edgesTo: (id) => toIndex.get(id) ?? [],
    resource: (kind, name) => nodes.get(resourceId(kind, name)) as ResourceGraphNode | undefined,
    resourceByName: (name) => byName.get(name),
    steps: (ownerId) => stepsByOwner.get(ownerId) ?? [],
    controlEdges: () => edges.filter(reachesTarget),
  };
}

/** The target resource NAME a ref site's value carries. Both written forms reach
 *  here: an unresolved `!ref <name>` sentinel and the `{kind, name}` object
 *  `resolveRefSentinels` rewrites it into. */
function refTargetName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (!value || typeof value !== "object") return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

export interface ProjectToPairsOptions {
  /** Keep only edges whose use satisfies this. Omit to keep every edge. */
  keepUse?: (use: RefUse[]) => boolean;
  /** Also include edges that are NOT injection sites (step slots behind a
   *  `$ref`, value-tree-discovered refs). Default false — see below. */
  includeNonInjected?: boolean;
}

/**
 * Unique `(from, to)` pairs, dropping slot identity and `use`. The projection
 * the init-order consumer needs — the only consumer for which the distinction
 * between two parallel edges genuinely does not matter.
 *
 * **Only injection sites order boot, and that is a property of the SITE, never
 * of the node kind.** A site the reference field map reaches is a Phase-5
 * injection site: the kernel puts the live instance into the field before
 * `init()`, so the target must be constructed first — and that is as true for
 * `Telo.Application`'s inline `targets[].invoke` (a step-declared slot the
 * field map reaches) as for a resource-level `connection:`. A step slot behind
 * a local `$ref` and a value-tree-discovered ref resolve at dispatch instead,
 * so their targets need only exist by the time the step runs. An earlier
 * revision keyed this on node kind and silently dropped boot targets' inline
 * invoke edges from init order — the regression this comment exists to prevent.
 *
 * Scoped nodes take no part at all: a `with:`-scoped resource is created when
 * the scope opens, and an edge into a scope is the owner's runtime business.
 */
export function projectToPairs(
  graph: CallGraph,
  options: ProjectToPairsOptions = {},
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, node] of graph.nodes) {
    if (node.type === "resource" && !node.scoped) out.set(id, new Set());
  }
  for (const edge of graph.edges) {
    if (!edge.to) continue;
    if (!edge.injected && !options.includeNonInjected) continue;
    if (options.keepUse && !options.keepUse(edge.use)) continue;
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (to?.type === "resource" && to.scoped) continue;
    let ownerId: string;
    if (from?.type === "step") ownerId = from.owner;
    else if (from?.type === "resource" && from.scoped) continue;
    else ownerId = edge.from;
    out.get(ownerId)?.add(edge.to);
  }
  return out;
}

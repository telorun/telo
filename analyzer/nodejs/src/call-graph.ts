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
 * **Four discovery mechanics, one graph.** Reference sites (Phase-5 injection
 * sites — `edge.injected`), schema-driven step slots in the step bodies the
 * reach deliberately stops at, a value-tree scan for `!ref`
 * anywhere else — so a ref in a structure no annotation anticipated is still an
 * edge (with no declared `use`, read conservatively) — and the module calls a
 * resource's expressions make (`edge.moduleCall`). Inline declarations
 * inside `x-telo-scope` arrays become nodes of their own and their slots are
 * walked, so a `with:`-scoped resource's references are part of the one model.
 *
 * Browser-safe: no Node built-ins.
 */
import { emittedStepIdentity, stepLabel, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { refSentinelTarget } from "./ref-sentinel-target.js";
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
  type RefSlot,
  type RefUse,
  type RefUseCases,
} from "./ref-slot.js";
import { isStepSlot } from "./step-slot.js";
import { topologyRoleOf, type TopologyRole } from "./topology-role.js";
import { type RefFieldEntry } from "./reference-field-map.js";
import { isInlineDeclaration, isResolvedReference } from "./resolved-reference.js";
import { enclosingDefault, siteRefEntry, type Pattern, type ReachRef } from "./reference-reach.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { moduleCallSites } from "./cel-access-chains.js";
import { shapeFieldsOf } from "./contract-shapes.js";
import {
  declaringModuleKey,
  moduleCallNamesByModule,
  moduleCallNamesOf,
  ROOT_MODULE_KEY,
  SELF_ALIAS,
} from "./module-call-names.js";
import { isModuleKind } from "./module-kinds.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import { declaredScopes, scopeMembers, type DeclaredScope } from "./scope-declarations.js";
import { isScopeMemberDeclaration } from "./scope-members.js";
import {
  importPathOf,
  importPathThrough,
  scopeSiteAt,
  scopeSiteAtPath,
  ScopedNameResolver,
  type DeclarationReading,
} from "./scoped-name-resolver.js";

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
  /** The owner's regions the scope's names resolve in, as keys from the
   *  owner's root (set iff `scoped`). */
  scopeRegions?: readonly (readonly string[])[];
}

export interface StepGraphNode {
  type: "step";
  id: string;
  /** The step's declared `name:`, when it has one. */
  name?: string;
  /** A step a template repeat emitted carries `__emitted` in place of `name`:
   *  its identity as text (`runs['a']`). */
  emitted?: string;
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
  /**
   * Which branch of the step grammar this step IS — the branch's own title
   * (`invoke`, `if/then/else`, `while/do`, `switch/cases/default`,
   * `try/catch/finally`, `throw`, `value`).
   *
   * Matched on the branch's REQUIRED keys, and IS those keys — sorted and
   * joined (`if+then`, `invoke`, `do+while`). A machine identity, so a consumer
   * may branch on it; it was the branch's `title`, which is prose an author may
   * reword at any time, and a view was splitting it on `/` to recover a keyword.
   * Absent for a step matching no branch — one just added, and still empty.
   */
  variant?: string;
  /** The branch's `title` as its author wrote it, for a view to render verbatim.
   *  Never parsed: it is a label, and the moment anything reads its SHAPE it
   *  becomes a vocabulary the author cannot change. */
  variantLabel?: string;
  /**
   * The expression that decides whether or how this step runs, as written: an
   * `if:`, a `while:`, a `switch:`, or the `when:` guard on a dispatch.
   *
   * Found through `x-telo-topology-role`, never by keyword, so a third-party
   * composer annotating its own predicate is read the same way.
   */
  predicate?: string;
  /** The field holding {@link predicate} (`if`, `while`, `switch`, `when`) — the
   *  one the step grammar annotates as a predicate or discriminator. */
  predicateField?: string;
  /**
   * Every reference slot this step's grammar declares — filled, empty, or
   * holding a declaration written at the site.
   *
   * Recorded here because this is the one place a step's item schema and its
   * value are both in hand: a step array's items are a step body, where the
   * reference reach deliberately stops, and a consumer
   * asking "what may this step dispatch to, and where is that written" has
   * nowhere else to look. An EMPTY slot is listed for exactly that reason — it
   * is a site an editor can offer to fill, and an edge says nothing about one.
   */
  refSlots?: { key: string; path: string; kinds: string[]; uses: RefUse[]; inline?: boolean }[];
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
  /** The import alias the reference is written through (`!ref Lib.sweep`),
   *  `Self` excluded. An export exists only once its import has initialized. */
  alias?: string;
  /** Field-map path of the slot — part of the edge's identity. */
  slot: string;
  /** The slot's pattern as segments, for an edge the reference reach found —
   *  exact for a property name holding a dot. */
  slotKeys?: Pattern;
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
  /** This site is a Phase-5 injection site — the reference reach reaches it, so
   *  the kernel puts the live instance into the field before `init()`. THE
   *  init-order criterion: injection is what forces construct-before-use,
   *  regardless of whether the slot is declared at resource level or inside an
   *  inline step array (`Telo.Application.targets`). Step slots in a step body
   *  and value-tree-discovered refs are not injection sites — those resolve at
   *  dispatch. */
  injected?: boolean;
  /** Found by the value-tree scan rather than a declared slot — no schema, no
   *  declared `use` (read conservatively as control-transferring). */
  nested?: boolean;
  /** The target is declared INSIDE the source's own `x-telo-scope`, so it is
   *  created on demand when the scope opens rather than at boot. Recorded rather
   *  than dropped: it is a real edge, and only the init-order consumer wants it
   *  gone. */
  scoped?: boolean;
  /**
   * A CEL module call (`Self.format(x)`) rather than a reference slot. `slot`
   * and `path` are the value holding the expression, `use` is `dependency`, and
   * `toName` is the called name as a reference to it would be written — the
   * bare name through `Self` or the module's own name, `<Alias>.<name>` across
   * an import, which this graph carries unresolved like a `!ref`. The kernel
   * binds every call a resource makes when it creates the resource, so the
   * callee must exist first: init order keeps these edges as it keeps injection
   * sites, and a body calling itself, directly or through another, is a cycle.
   */
  moduleCall?: boolean;
}

export interface CallGraph {
  nodes: ReadonlyMap<string, CallGraphNode>;
  edges: readonly CallGraphEdge[];
  /** Edges leaving a node, in declaration order. */
  edgesFrom(id: string): CallGraphEdge[];
  /** Edges arriving at a resource node. */
  edgesTo(id: string): CallGraphEdge[];
  resource(kind: string, name: string): ResourceGraphNode | undefined;
  /**
   * The resource a bare name addresses, read from `fromModule`'s scope.
   *
   * A name is module-scoped, so the module is how two declarations of one name
   * are told apart — see {@link resolveScopedName}. Omitting it answers for a
   * name declared once and, where several modules declare it, declines rather
   * than taking whichever came first.
   */
  resourceByName(name: string, fromModule?: string): ResourceGraphNode | undefined;
  /** Step nodes declared by a resource, in lexical order. */
  steps(resourceId: string): StepGraphNode[];
  /** Every edge whose `use` includes at least one control transfer, plus every
   *  edge whose slot declares no `use` at all — see {@link CallGraph.controlEdges}. */
  controlEdges(): CallGraphEdge[];
}

export const resourceId = (kind: string, name: string): string => `${kind}\0${name}`;

/**
 * The id a manifest's node is keyed by.
 *
 * **A resource name is MODULE-SCOPED**, so `(kind, name)` is unique inside one
 * module and not across a flattened set: two libraries each exporting an
 * `Http.Api` named `routes` are two declarations, and keying both as
 * `http.Api\0routes` silently made them one — the second overwrote the first,
 * taking its edges and its steps with it. The module is part of the identity
 * wherever the loader stamped one; a manifest with no stamp keeps the bare form,
 * so nothing that never crossed a module boundary moves.
 */
export function nodeIdFor(manifest: ResourceManifest): string {
  const kind = manifest.kind as string;
  const name = manifest.metadata?.name as string;
  const module = (manifest.metadata as { module?: string } | undefined)?.module;
  // One instance of a module imported several times is one copy among them.
  const instance = importPathOf(manifest);
  const scoped = instance ? `${module}/${instance.join("/")}` : module;
  return scoped ? `${scoped}\0${resourceId(kind, name)}` : resourceId(kind, name);
}

/** The module a manifest was declared in, when the loader stamped one. */
const declaringModule = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { module?: string } | undefined)?.module;

export { resolveScopedName } from "./scoped-name-resolver.js";

/** How a graph node names itself and the module that declared it. */
const NODE_READING: DeclarationReading<ResourceGraphNode> = {
  nameOf: (node) => node.name,
  moduleOf: (node) => declaringModule(node.manifest),
  importPathOf: (node) => importPathOf(node.manifest),
};

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

/** A site's selector defaults, read off the reach: the first slot at the site
 *  whose enclosing object declares one (`enclosingDefault`). */
function reachDefault(refs: readonly ReachRef[]): SchemaDefault {
  if (refs.length === 0) return NO_DEFAULT;
  return (pointer) => {
    for (const ref of refs) {
      const value = enclosingDefault(ref, pointer);
      if (value !== undefined) return value;
    }
    return undefined;
  };
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
/** Whether `concretePath` sits in one of the fields a contract or signature
 *  names a shape through (`contract-shapes.ts`, the one reader of which those are). */
function isShapeField(manifest: ResourceManifest, concretePath: string): boolean {
  const head = concretePath.split(/[.[]/, 1)[0]!;
  return shapeFieldsOf(manifest).includes(head);
}

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

/**
 * A slot's use at one concrete site of one resource, for a consumer that walks
 * the resource's reach itself rather than reading the graph's edges.
 *
 * The same rule the graph applies to a resource-level edge — the same enclosing
 * object, the same schema default — so a consumer and an edge cannot disagree
 * about which case of a case map holds. `concretePath` is the site
 * (`routes[0].handler`); `ref` is the reach slot it resolved from, whose
 * enclosing declarations the schema default is read against.
 */
export function resolveSlotUseAt(
  slot: RefSlot,
  resource: unknown,
  ref: ReachRef,
  concretePath: string,
): Pick<CallGraphEdge, "use" | "unresolved" | "unresolvedReason"> {
  const entry: RefFieldEntry = {
    refs: slot.kinds,
    uses: slot.uses,
    isArray: false,
    ...(slot.useCases ? { useCases: slot.useCases } : {}),
  };
  return resolveUseAtSite(entry, resource, concretePath, reachDefault([ref]));
}

/** A resolved reference — the shape `resolveRefSentinels` leaves at a ref
 *  site. NOT a step: a bare boot target written `!ref X` must not mint a step
 *  node. */
function isPlainRefValue(value: Record<string, unknown>): boolean {
  return isResolvedReference(value);
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
 * What a step IS, and what decides whether it runs.
 *
 * Both come off the schema rather than off a keyword list: the variant is the
 * `oneOf` branch whose REQUIRED keys the step carries, and the predicate is the
 * field annotated as one. A composer that declares a step body of its own is
 * therefore described in its own words, and nothing here knows that `while`
 * exists.
 *
 * A step matching several branches takes the FIRST — the grammar is a `oneOf`,
 * so more than one match is a manifest the checker rejects, and guessing among
 * them would be a second opinion on a question the checker already answers.
 */
function classifyStep(
  step: Record<string, unknown>,
  itemSchema: Record<string, any> | undefined,
  rootSchema: Record<string, any>,
): { variant?: string; variantLabel?: string; predicate?: string; predicateField?: string } {
  if (!itemSchema) return {};
  const branches = Array.isArray(itemSchema.oneOf) ? itemSchema.oneOf : [];
  let variant: string | undefined;
  let variantLabel: string | undefined;
  for (const raw of branches) {
    const branch = resolveLocalRef(raw, rootSchema);
    const required = Array.isArray(branch?.required) ? (branch.required as string[]) : [];
    if (required.length === 0 || !required.every((key) => step[key] !== undefined)) continue;
    // The keys are what the branch IS; the title is what it is called.
    variant = [...required].sort().join("+");
    if (typeof branch?.title === "string") variantLabel = branch.title;
    break;
  }

  let predicate: string | undefined;
  let predicateField: string | undefined;
  for (const [key, propSchema] of propertySchemas(itemSchema)) {
    const role = topologyRoleOf(propSchema);
    if (role !== "predicate" && role !== "discriminator") continue;
    const written = expressionSource(step[key]);
    if (written !== undefined) {
      predicate = written;
      predicateField = key;
      break;
    }
  }
  return {
    ...(variant ? { variant } : {}),
    ...(variantLabel ? { variantLabel } : {}),
    ...(predicate ? { predicate, predicateField } : {}),
  };
}

/** A predicate as the author wrote it. A CEL value reaches here as a tagged
 *  sentinel or as an already-compiled node, and the SOURCE is the only part of
 *  either worth showing. */
function expressionSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { source?: unknown; __compiled?: unknown };
  return typeof record.source === "string" ? record.source : undefined;
}

/**
 * Emit the edges a single step's own ref slots declare.
 *
 * Read from the step ITEM SCHEMA rather than from the reference reach: a step
 * array's items are a step body, where the reach deliberately stops (reaching
 * it would turn every step's `invoke` into a Phase-5 injection site). The schema is already in hand here, so the
 * graph sees these slots at no cost to the kernel's injection surface.
 */
function emitStepEdges(node: StepGraphNode, ctx: StepWalkContext): void {
  if (!ctx.itemSchema) return;
  const schemaDefault = schemaDefaultOf(ctx.itemSchema);
  for (const [key, propSchema] of propertySchemas(ctx.itemSchema)) {
    const slot = readRefSlot(propSchema);
    if (!slot || slot.kinds.length === 0) continue;
    const written = node.step[key];
    const inline =
      written !== null &&
      typeof written === "object" &&
      !Array.isArray(written) &&
      isInlineDeclaration(written);
    // Every declared slot is recorded, whatever is in it: an empty one is a
    // site an editor can fill, and a declaration written at the site is a real
    // dispatch that emits no edge — which is what made an inline step read
    // exactly like one that dispatches nothing.
    node.refSlots = [
      ...(node.refSlots ?? []),
      {
        key,
        path: `${node.path}.${key}`,
        kinds: slot.kinds,
        uses: possibleUses(slot),
        ...(inline ? { inline: true } : {}),
      },
    ];
    const targetName = refTargetName(written);
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
    role: TopologyRole,
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
          const subRole = topologyRoleOf(subSchema);
          if (!subRole) continue;
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
    else if (emittedStepIdentity(value)) node.emitted = stepLabel(value);
    const { variant, variantLabel, predicate, predicateField } = classifyStep(value, ctx.itemSchema, ctx.rootSchema);
    if (variant) node.variant = variant;
    if (variantLabel) node.variantLabel = variantLabel;
    if (predicate) {
      node.predicate = predicate;
      node.predicateField = predicateField;
    }
    if (parent) node.parent = parent;
    ctx.nodes.set(id, node);
    ctx.order.push(node);
    emitStepEdges(node, ctx);

    if (!ctx.itemSchema) return;
    for (const [key, propSchema] of propertySchemas(ctx.itemSchema)) {
      const role = topologyRoleOf(propSchema);
      if (!role) continue;
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
   * selection as the registry's reach.
   */
  const definitionFor = (manifest: ResourceManifest): ResourceDefinition | undefined => {
    const direct = registry.resolve(manifest.kind as string);
    if (direct) return direct;
    const scope = moduleAliasScope(manifest.metadata, options.aliases, options.aliasesByModule);
    const canonical = scope?.resolveKind(manifest.kind as string);
    return canonical ? registry.resolve(canonical) : undefined;
  };

  for (const manifest of resources) {
    const name = manifest.metadata?.name;
    if (!name || !manifest.kind || isKindDocumentOrImport(manifest)) continue;
    // A scope member is a node of its holder's scope, declared there.
    if (isScopeMemberDeclaration(manifest)) continue;
    const node: ResourceGraphNode = {
      type: "resource",
      id: nodeIdFor(manifest),
      kind: manifest.kind,
      name: name as string,
      manifest,
    };
    if (nodes.has(node.id)) continue;
    nodes.set(node.id, node);
  }
  const topLevel = [...nodes.values()] as ResourceGraphNode[];
  const names = new ScopedNameResolver(topLevel, NODE_READING);
  /** The node a reference through an import alias reaches, where that import's
   *  module is imported as several instances; undefined anywhere else. */
  const instanceThrough = (
    value: unknown,
    source: ResourceManifest,
    name: string,
  ): ResourceGraphNode | undefined => {
    const alias = (value as { alias?: unknown } | null)?.alias;
    if (typeof alias !== "string" || alias === "Self") return undefined;
    const module = moduleAliasScope(source.metadata, options.aliases, options.aliasesByModule)?.moduleForAlias(alias);
    if (!module || names.declarationsOf(name).filter((n) => declaringModule(n.manifest) === module).length < 2) {
      return undefined;
    }
    return names.inModule(name, module, importPathThrough(source, alias));
  };

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

  for (const node of topLevel) {
    collectStepsFor(node, (name) => names.resolve(name, declaringModule(node.manifest)));
  }

  /** Re-resolve `ownerId`'s step edges against the scopes it declares. */
  const rescopeStepEdges = (
    ownerId: string,
    holder: ScopeAddress,
    scopes: readonly DeclaredScope[],
    module: string | undefined,
  ): void => {
    for (const [key, edge] of stepEdgesByPath) {
      if (!key.startsWith(`${ownerId}\0`)) continue;
      const found = names.locate(edge.toName, module, scopeSiteAtPath(holder, scopes, edge.path));
      if (!found?.address.scope) continue;
      edge.to = found.declaration.id;
      edge.scoped = true;
    }
  };

  /**
   * Every member of `scopes` as a node of its own — ONE per member, keyed by
   * its scope site (`<owner>#with#<kind>/<name>`), the declaration-site identity
   * the zones correlate on — with its own reference and step edges, resolved
   * scope first, and the members of the scopes it declares in turn. A member is
   * reached through its holder whether or not the set also holds it as a
   * declaration: an editor's projection holds only top-level documents.
   * Excluded from init ordering (created when the scope opens).
   */
  const declareScopedMembers = (
    ownerId: string,
    holder: ScopeAddress,
    scopes: readonly DeclaredScope[],
    module: string | undefined,
  ): boolean => {
    const declared: Array<{ node: ResourceGraphNode; site: ScopeSite }> = [];
    for (const scope of scopes) {
      const site: ScopeSite = { holder, field: scope.path };
      const members: ResourceGraphNode[] = [];
      for (const manifest of scopeMembers(scope)) {
        if (!manifest.kind) continue;
        const name = manifest.metadata.name;
        const node: ResourceGraphNode = {
          type: "resource",
          id: `${ownerId}#${scope.path}#${resourceId(manifest.kind, name)}`,
          kind: manifest.kind,
          name,
          manifest,
          scoped: true,
          scopeOwner: ownerId,
          scopeSite: scope.path,
          scopeRegions: scope.regions,
        };
        if (nodes.has(node.id)) continue;
        nodes.set(node.id, node);
        members.push(node);
        declared.push({ node, site });
      }
      names.declareScope(site, members);
    }
    for (const { node, site } of declared) {
      const address = scopeAddress(site, node.name);
      // A member's kind is written in its holder's module, whose alias table the
      // registry reads off `metadata.module`.
      const view =
        module !== undefined && declaringModule(node.manifest) === undefined
          ? ({ ...node.manifest, metadata: { ...node.manifest.metadata, module } } as ResourceManifest)
          : node.manifest;
      const sites = registry.referenceSites(view, options.aliases, options.aliasesByModule, node.manifest);
      const ownScopes = declaredScopes(sites);
      // The scoped resource's own ref slots, at its concrete sites.
      for (const site of sites) {
        if (site.refs.length === 0) continue;
        const targetName = refTargetName(site.data);
        if (targetName === undefined) continue;
        const { fieldPath, fieldKeys } = site.refs[0]!;
        const entry = siteRefEntry(site);
        const { use, unresolved, unresolvedReason } = resolveUseAtSite(
          entry,
          node.manifest,
          site.path,
          reachDefault(site.refs),
        );
        const edge: CallGraphEdge = {
          from: node.id,
          toName: targetName,
          slot: fieldPath,
          slotKeys: fieldKeys,
          path: site.path,
          use,
        };
        const target = names.locate(targetName, module, scopeSiteAt(address, ownScopes, site.keys));
        if (target) edge.to = target.declaration.id;
        if (target?.address.scope) edge.scoped = true;
        if (unresolved) edge.unresolved = unresolved;
        if (unresolvedReason) edge.unresolvedReason = unresolvedReason;
        if (entry.inputs !== undefined) edge.inputs = entry.inputs;
        edges.push(edge);
      }
      // Its step arrays too, resolved scope-local first.
      collectStepsFor(node, (name) => names.resolve(name, module, site));
      if (declareScopedMembers(node.id, address, ownScopes, module)) {
        rescopeStepEdges(node.id, address, ownScopes, module);
      }
    }
    return declared.length > 0;
  };

  // --- edges ---
  // The visitor fires `onScope` before a resource's ref sites, so a scope is
  // declared to the resolver before any edge it qualifies is added.
  visitManifest(
    resources,
    registry,
    {
      onScope: (event) => {
        const ownerName = event.source.metadata?.name as string | undefined;
        if (!ownerName || !event.source.kind || !event.holder) return;
        const ownerId = nodeIdFor(event.source);
        const ownerModule = declaringModule(event.source);
        const holder = event.holder;
        if (!declareScopedMembers(ownerId, holder, event.scopes, ownerModule)) return;

        // The owner's own step edges were emitted before this scope was seen
        // (step collection precedes the visit), so their names resolved
        // module-level. Re-resolve them now that the scope exists, so a step's
        // `invoke: !ref X` with X declared in `with:` reaches the scoped node,
        // never a same-named module-level shadow.
        rescopeStepEdges(ownerId, holder, event.scopes, ownerModule);
      },
      onRef: (event) => {
        const sourceName = event.source.metadata?.name as string | undefined;
        if (!sourceName || !event.source.kind) return;
        const sourceId = nodeIdFor(event.source);
        if (!nodes.has(sourceId)) return;

        // A site inside a step was already emitted by the step walk, which
        // reads the step item schema directly. When the REACH also reaches it
        // — `Telo.Application`'s inline `targets[].invoke`, unlike a
        // `Run.Sequence` step body's `steps[].invoke` — the site is a
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

        const schemaDefault = reachDefault(event.refs);
        // A shape a contract or signature names (`params[0].schema: !ref Money`)
        // sits in no declared slot, but what it states is known: it names a
        // shape, so it is a `schema` reference rather than an unknown one.
        const { use, unresolved, unresolvedReason }: Pick<
          CallGraphEdge,
          "use" | "unresolved" | "unresolvedReason"
        > =
          event.nested && isShapeField(event.source, event.concretePath)
            ? { use: ["schema"] }
            : resolveUseAtSite(event.entry, event.source, event.concretePath, schemaDefault);
        const edge: CallGraphEdge = {
          from: sourceId,
          toName: targetName,
          slot: event.fieldPath,
          ...(event.fieldKeys ? { slotKeys: event.fieldKeys } : {}),
          path: event.concretePath,
          use,
        };
        const found = names.locate(targetName, declaringModule(event.source), event.within);
        // A reference through an import of a module imported several times
        // reaches that import's instance.
        const instance = instanceThrough(event.value, event.source, targetName);
        if (instance) edge.to = instance.id;
        else if (found) edge.to = found.declaration.id;
        if (unresolved) edge.unresolved = unresolved;
        if (unresolvedReason) edge.unresolvedReason = unresolvedReason;
        if (event.entry.inputs !== undefined) edge.inputs = event.entry.inputs;
        const alias = referenceAlias(event.value);
        if (alias !== undefined) edge.alias = alias;
        if (event.nested) edge.nested = true;
        else edge.injected = true;
        if (found?.address.scope) edge.scoped = true;
        edges.push(edge);
      },
    },
    {
      aliases: options.aliases,
      aliasesByModule: options.aliasesByModule,
      // A scope member is reached through its holder, above.
      skip: (m) => isKindDocumentOrImport(m) || isScopeMemberDeclaration(m),
      expand: true,
      discoverNestedRefs: true,
    },
  );

  // --- module calls ---
  // Resolved as the kernel binds them: through `Self` or the module's own name
  // among the declaring module's own resources, never a `with:` scope's;
  // through an alias to the import, whose export this graph does not follow.
  const callNames = moduleCallNamesByModule(resources);
  const rootModules = new Set<string>();
  for (const manifest of resources) {
    const name = manifest.metadata?.name;
    if (isModuleKind(manifest.kind as string) && typeof name === "string") rootModules.add(name);
  }
  const moduleKeyOf = (manifest: ResourceManifest): string => {
    const key = declaringModuleKey(manifest);
    return rootModules.has(key) ? ROOT_MODULE_KEY : key;
  };
  const callees = new ScopedNameResolver(topLevel, {
    nameOf: (node) => node.name,
    moduleOf: (node) => moduleKeyOf(node.manifest),
  });
  for (const node of [...nodes.values()]) {
    if (node.type !== "resource" || node.scoped) continue;
    const module = moduleKeyOf(node.manifest);
    const ownNames = module === ROOT_MODULE_KEY ? rootModules : new Set([module]);
    for (const { path, call } of moduleCallSites(
      node.manifest,
      moduleCallNamesOf(callNames, node.manifest),
    )) {
      const dot = call.indexOf(".");
      const receiver = call.slice(0, dot);
      const own = receiver === SELF_ALIAS || ownNames.has(receiver);
      const toName = own ? call.slice(dot + 1) : call;
      const edge: CallGraphEdge = {
        from: node.id,
        toName,
        slot: path,
        path,
        use: ["dependency"],
        moduleCall: true,
      };
      const target = own ? callees.inModule(toName, module) : undefined;
      if (target) edge.to = target.id;
      edges.push(edge);
    }
  }

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
    // Both accessors take a name with no module, so both answer for the one
    // declaration that name has — and, where a flattened set has several, the
    // first in declaration order. A caller that must tell two apart holds a
    // node id, which carries the module.
    resource: (kind, name) =>
      (nodes.get(resourceId(kind, name)) as ResourceGraphNode | undefined) ??
      names.declarationsOf(name).find((n) => n.kind === kind),
    resourceByName: (name, fromModule) => names.resolve(name, fromModule),
    steps: (ownerId) => stepsByOwner.get(ownerId) ?? [],
    controlEdges: () => edges.filter(reachesTarget),
  };
}

/** The import alias a ref site's value is written through, `Self` excluded. */
function referenceAlias(value: unknown): string | undefined {
  const alias = refSentinelTarget(value)?.alias ?? (isResolvedReference(value) ? value.alias : undefined);
  return typeof alias === "string" && alias !== "Self" ? alias : undefined;
}

/** The target resource NAME a ref site's value carries. Both written forms reach
 *  here: an unresolved `!ref <name>` sentinel and the resolved reference
 *  `resolveRefSentinels` rewrites it into. */
function refTargetName(value: unknown): string | undefined {
  // An edge's target is taken VERBATIM — the scoped name resolver
  // are what resolve it, and a cross-module `Alias.name` is a target this graph
  // legitimately carries unresolved. That is this pass's reduction over the
  // shared parse, not a second reading of the tag.
  const sentinel = refSentinelTarget(value);
  // A family member's edge reaches the family: one box, whichever member.
  if (sentinel) return sentinel.indexes.length > 0 ? sentinel.name : sentinel.source;
  return isResolvedReference(value) ? value.name : undefined;
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
 * of the node kind.** A site the reference reach reaches is a Phase-5
 * injection site: the kernel puts the live instance into the field before
 * `init()`, so the target must be constructed first — and that is as true for
 * `Telo.Application`'s inline `targets[].invoke` (a step-declared slot the
 * reach reaches, its `items` being a reference slot) as for a resource-level
 * `connection:`. A step slot in a step body and a value-tree-discovered ref
 * resolve at dispatch instead, so their targets need only exist by the time
 * the step runs. An earlier
 * revision keyed this on node kind and silently dropped boot targets' inline
 * invoke edges from init order — the regression this comment exists to prevent.
 * A module call orders boot for the injection site's reason: the kernel binds
 * it when the caller is created, so the callee is constructed first.
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
    if (!edge.injected && !edge.moduleCall && !options.includeNonInjected) continue;
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

/**
 * Every reference slot naming `manifest`: the resource declaring the slot and
 * its concrete path. A module call and a step's dispatch are not such slots.
 */
export function referrerSlotsOf(
  graph: CallGraph,
  manifest: ResourceManifest,
): Array<{ manifest: ResourceManifest; path: string }> {
  const out: Array<{ manifest: ResourceManifest; path: string }> = [];
  for (const edge of graph.edgesTo(nodeIdFor(manifest))) {
    if (edge.moduleCall) continue;
    const from = graph.nodes.get(edge.from);
    if (!from || from.type !== "resource") continue;
    out.push({ manifest: from.manifest, path: edge.path });
  }
  return out;
}

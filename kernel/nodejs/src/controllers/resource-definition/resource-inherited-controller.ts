import type {
  CompiledValue,
  ControllerInstance,
  EvaluationContext,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";
import { isCelRecord, isCompiledValue } from "@telorun/sdk";
import {
  effectiveAuthorSchema,
  isResolvedReference,
  reachSites,
  resolveParent,
  SELF_PATH,
  type DefResolver,
} from "@telorun/analyzer";
import { isRefSentinel } from "@telorun/templating";
import { celHostScopeValue } from "../../cel-host-scope-value.js";
import { declaringContextOf } from "./declaring-context.js";
import { mappingProvenance, recordTextProvenance, textProvenanceOf } from "../../text-records.js";
import { forwardedValue, type WrittenScope } from "./reference-crossing.js";
import { isWithinSlot, stepValueSlots } from "./step-value-slots.js";

/** Typed internal seam implemented by the concrete `ResourceContextImpl`: runs
 *  the kernel's create phase for the parent-kind manifest and returns the native
 *  parent instance (or null when the parent controller isn't registered yet — a
 *  retry, same as `_createInstance`). Off the public SDK surface, like
 *  `registerLazyController`. */
export interface InheritedInstanceHost extends WrittenScope {
  createInheritedInstance(
    evalContext: EvaluationContext,
    resource: Record<string, unknown>,
  ): Promise<ResourceInstance | null>;
  /** A declaration as a read past a reference sees it: a named shape with its
   *  `extends` folded. */
  readAcrossReference(declaration: ResourceManifest): ResourceManifest;
}

/** What a bare `self.<path>` in a mapping reads: `forwardedValue` over `self`. */
type SelfForward = (keys: readonly string[]) => unknown;

interface Snapshotable {
  snapshot(): Record<string, unknown>;
}
const hasSnapshot = (v: unknown): v is Snapshotable =>
  !!v && typeof (v as { snapshot?: unknown }).snapshot === "function";

/** Resolves a reference-slot value to its live instance, or undefined when the
 *  referenced resource isn't initialized yet. A value that is already a live
 *  instance (has `snapshot()`) passes through. Post Phase-2.5 a slot holds a
 *  `{kind, name, alias?}` object; a raw `!ref` sentinel (only reachable behind a
 *  hidden `$ref` slot) is normalized through the sanctioned `ctx.ensureKindRef`
 *  so the reference grammar (alias/Self splitting) stays in one place. */
function resolveRefSlot(value: unknown, ctx: ResourceContext): ResourceInstance | undefined {
  if (hasSnapshot(value)) return value as unknown as ResourceInstance;
  let name: string | undefined;
  let alias: string | undefined;
  if (isRefSentinel(value)) {
    const ref = ctx.ensureKindRef(value) as { name: string; alias?: string };
    name = ref.name;
    alias = ref.alias;
  } else if (isResolvedReference(value)) {
    name = value.name;
    alias = value.alias;
  }
  if (!name) return undefined;
  const instance =
    alias && alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(alias, name)
      : (ctx.moduleContext.resourceInstances.get(name)?.instance as ResourceInstance | undefined);
  return instance ?? undefined;
}

/** Expressions a mapping leaves compiled — at or beneath `slots`, spelled as the
 *  mapping's paths are (`base.steps[0].value`) — and how each is handed on, given
 *  where it was written. */
interface KeptExpressions {
  slots: readonly string[];
  keep(value: CompiledValue, where: string): CompiledValue;
}

/**
 * `value` left an expression that reads `self` as the instance it was built for,
 * wherever it is later evaluated: the parent evaluates a step's `value:` at
 * dispatch, in a context that binds no `self` of its own. Bound for the one call
 * and restored after, as `expandWith` binds its scope; a failure names where the
 * expression was written, as one evaluated at creation does.
 */
function withSelfBound(
  value: CompiledValue,
  self: Record<string, unknown>,
  where: string,
): CompiledValue {
  let view: unknown;
  return {
    ...value,
    call: (activation: Record<string, unknown>) => {
      view ??= celHostScopeValue(self);
      const previous = Object.getOwnPropertyDescriptor(activation, "self");
      Object.defineProperty(activation, "self", {
        value: view,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      try {
        return value.call(activation);
      } catch (error) {
        if (error instanceof Error) error.message = `in ${where}: ${error.message}`;
        throw error;
      } finally {
        if (previous) Object.defineProperty(activation, "self", previous);
        else delete activation.self;
      }
    },
  };
}

/** Expand a mapping node against a CEL scope. `self`-only CEL resolves to
 *  literals now; a pure `self.<path>` access is navigated by `forward`, reading
 *  declarations only, so live instances pass through (CEL's output type checker
 *  rejects them) and no member of one is read. Shared by
 *  `base:` (construction, scope `{ self }`) and the dispatch mappings
 *  `inputs:` / `result:` (scope `{ self, inputs }` / `{ self, result }`).
 *  A failing expression's message names the field it sits in (`path`) and the
 *  definition that wrote it (`owner`), which is not the resource being created. */
function expandMappingNode(
  value: unknown,
  scope: Record<string, unknown>,
  forward: SelfForward,
  ctx: EvaluationContext,
  path: string,
  owner: string,
  kept?: KeptExpressions,
): unknown {
  if (isCompiledValue(value)) {
    if (kept && isWithinSlot(kept.slots, path)) return kept.keep(value, `${path} of ${owner}`);
    const src = typeof value.source === "string" ? value.source.trim() : "";
    const m = src.match(SELF_PATH);
    if (m) return forward(m[1].split(".").slice(1));
    try {
      return ctx.expandWith(value, scope);
    } catch (error) {
      if (error instanceof Error) error.message = `in ${path} of ${owner}: ${error.message}`;
      throw error;
    }
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => expandMappingNode(v, scope, forward, ctx, `${path}[${i}]`, owner, kept));
  }
  // Asked of the value DOMAIN, never of the prototype: a branded CEL value (an
  // instant, a duration, a uint) is a plain object, and rebuilding one from its
  // entries drops the symbol its brand lives under.
  if (value !== null && typeof value === "object" && isCelRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const expanded = expandMappingNode(v, scope, forward, ctx, `${path}.${k}`, owner, kept);
      // An absent optional stays absent: a key holding `undefined` would read
      // as present to the next level's `has()` and hand CEL a non-value.
      if (expanded !== undefined) out[k] = expanded;
    }
    return out;
  }
  return value;
}

/** `GoogleAuth.GoogleClient (oci://…/telo.yaml)` — the definition a mapping was written in. */
function mappingOwner(definition: ResourceDefinition): string {
  const source = (definition.metadata as { source?: unknown }).source;
  const kind = `${definition.metadata.module}.${definition.metadata.name}`;
  return typeof source === "string" ? `${kind} (${source})` : kind;
}

/**
 * Bind the dispatch mappings of a child that REPLACED its inherited contract.
 *
 * A contract resolves to the nearest declaration along `extends` and never
 * merges, so a child declaring `inputType` presents a signature the inherited
 * controller has never heard of. `inputs:` is the adapter that turns the child's
 * signature into the parent's call, and `result:` turns the parent's result back
 * into the child's declared output — the same top-level-sibling factoring a
 * template definition uses for `invoke:`.
 *
 * Bound onto the parent instance rather than wrapping it, so the child still IS
 * a parent instance: `init`, `snapshot`, `teardown` and status plumbing are
 * untouched, and nothing new appears in a declared ref slot. It composes with
 * the kernel's contract binding by position — the parent's contract was bound
 * when the parent instance was produced, this mapping goes on next, and the
 * child's own contract is bound outermost by the caller. One dispatch therefore
 * checks the child's inputs, maps, checks the parent's inputs, runs, checks the
 * parent's result, maps back, and checks the child's result.
 */
function bindDispatchMapping(
  instance: ResourceInstance,
  definition: ResourceDefinition,
  self: Record<string, unknown>,
  forward: SelfForward,
  ctx: EvaluationContext,
): void {
  const body = definition as unknown as { inputs?: unknown; result?: unknown };
  const inputsMapping = body.inputs;
  const resultMapping = body.result;
  if (inputsMapping == null && resultMapping == null) return;
  if (typeof instance.invoke !== "function") return;

  // Every argument is forwarded — the mapping rewrites `inputs`, while the
  // InvokeContext (cancellation, tracing) in later parameters belongs to the
  // caller and must reach the inherited controller untouched.
  const original = instance.invoke.bind(instance) as (
    inputs: any,
    ...rest: unknown[]
  ) => Promise<unknown>;
  instance.invoke = async (inputs: any, ...rest: unknown[]) => {
    const mappedInputs =
      inputsMapping != null
        ? (expandMappingNode(
            inputsMapping,
            { self, inputs },
            forward,
            ctx,
            "inputs",
            mappingOwner(definition),
          ) as Record<string, unknown>)
        : inputs;
    const result = await original(mappedInputs, ...rest);
    return resultMapping != null
      ? expandMappingNode(resultMapping, { self, result }, forward, ctx, "result", mappingOwner(definition))
      : result;
  };
}

/**
 * Controller for a definition that inherits its controller by delegation — it
 * `extends` a concrete kind, declares no own `controllers:` / template body, and
 * maps the parent's config via `base:`. `create()` evaluates `base:` against the
 * child instance's config (`self`, with reference slots resolved to live
 * instances) and constructs the parent kind through {@link InheritedInstanceHost},
 * returning that native parent instance verbatim so the child duck-types as its
 * parent (e.g. inherits `.snapshot()`).
 */
export function createInheritedController(
  definition: ResourceDefinition,
  resolveDef: DefResolver,
): ControllerInstance {
  const authorSchema = effectiveAuthorSchema(definition, resolveDef);
  const parentKind = definition.extends;
  if (!parentKind) {
    throw new Error(
      `Telo.Definition '${definition.metadata.name}': inherited controller requires an 'extends' target.`,
    );
  }
  const base = definition.base;
  // `base:` builds the parent's configuration, so a pure step's `value:` in it
  // is found through the parent kind's step-body declaration: the parent's step
  // engine reads a number there as one the author wrote, and one `base:`
  // computed from `self` must not be.
  const parentDef = resolveParent(definition, resolveDef);
  const baseValueSlots =
    base != null && typeof base === "object" && parentDef
      ? stepValueSlots(
          base as Record<string, unknown>,
          effectiveAuthorSchema(parentDef, resolveDef),
          (kind) => {
            const def = resolveDef(kind, definition);
            return def ? effectiveAuthorSchema(def, resolveDef) : undefined;
          },
        ).map((slot) => `base.${slot}`)
      : [];

  return {
    create: async (resource: any, ctx: ResourceContext): Promise<ResourceInstance | null> => {
      const definingContext = declaringContextOf(resource, ctx);
      const self: Record<string, unknown> = { ...resource, name: resource.metadata.name };
      // Top-level reference sites of the author-facing schema — resolved to live
      // instances before `base:` runs so a `!cel "self.<ref>"` passthrough
      // forwards the live parent instance (e.g. a `client` into an inherited
      // Http.Request).
      for (const site of reachSites(authorSchema ?? {}, resource)) {
        if (site.refs.length === 0 || site.keys.length !== 1) continue;
        const path = String(site.keys[0]);
        const raw = site.data;
        const live = resolveRefSlot(raw, ctx);
        // A reference that is set but hasn't resolved yet means the dependency
        // isn't initialized — defer via the retry signal, like _createInstance.
        if (!live) return null;
        self[path] = live;
      }

      const host = ctx as unknown as InheritedInstanceHost;
      const forward: SelfForward = (keys) =>
        forwardedValue(self, keys, host, (declaration) => {
          if (typeof (host as { readAcrossReference?: unknown }).readAcrossReference !== "function") {
            throw new Error(
              `Telo.Definition '${definition.metadata.name}': inherited controller requires a ResourceContext host that implements readAcrossReference().`,
            );
          }
          return host.readAcrossReference(declaration);
        });

      // With `base:`, it maps `self` onto the parent's (narrowed) config. Without
      // it, the child is a pure additive extension: it carries the parent's config
      // fields directly, so forward them (reference slots already resolved to live
      // instances in `self`), minus the reserved keys.
      let parentConfig: Record<string, unknown>;
      if (base != null) {
        parentConfig = expandMappingNode(
          base,
          { self },
          forward,
          definingContext,
          "base",
          mappingOwner(definition),
          baseValueSlots.length > 0
            ? { slots: baseValueSlots, keep: (value, where) => withSelfBound(value, self, where) }
            : undefined,
        ) as Record<string, unknown>;
      } else {
        const { kind: _kind, metadata: _metadata, name: _name, ...config } = self;
        parentConfig = config;
      }
      const parentResource: Record<string, unknown> = {
        kind: parentKind,
        metadata: { ...resource.metadata },
        ...parentConfig,
      };
      // Who wrote each value the parent receives: what `base:` forwards verbatim
      // is the consumer's, a literal there the module declaring this kind's, and
      // anything else computed; without `base:` the consumer's config whole.
      const provenance = textProvenanceOf(resource);
      if (provenance) {
        recordTextProvenance(
          parentResource,
          base != null ? mappingProvenance(base, self, provenance) : provenance,
        );
      }
      if (typeof (host as { createInheritedInstance?: unknown }).createInheritedInstance !== "function") {
        throw new Error(
          `Telo.Definition '${definition.metadata.name}': inherited controller requires a ResourceContext host that implements createInheritedInstance().`,
        );
      }
      const instance = await host.createInheritedInstance(definingContext, parentResource);
      if (!instance) return null;
      bindDispatchMapping(instance, definition, self, forward, definingContext);
      return instance;
    },
  };
}

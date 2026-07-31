import type {
  ControllerInstance,
  EvaluationContext,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
} from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  buildReferenceFieldMap,
  effectiveAuthorSchema,
  isRefEntry,
  type DefResolver,
} from "@telorun/analyzer";
import { isRefSentinel } from "@telorun/templating";

/** Typed internal seam implemented by the concrete `ResourceContextImpl`: runs
 *  the kernel's create phase for the parent-kind manifest and returns the native
 *  parent instance (or null when the parent controller isn't registered yet — a
 *  retry, same as `_createInstance`). Off the public SDK surface, like
 *  `registerLazyController`. */
export interface InheritedInstanceHost {
  createInheritedInstance(
    evalContext: EvaluationContext,
    resource: Record<string, unknown>,
  ): Promise<ResourceInstance | null>;
}

/** Matches a CEL source that is exactly a `self.<path>` member access — resolved
 *  by direct navigation so live resource instances (which CEL's output type
 *  checker rejects) can flow through `base:` untouched. */
const SELF_PATH = /^self((?:\.[A-Za-z_$][\w$]*)+)$/;

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
  } else if (value && typeof value === "object") {
    const ref = value as { name?: unknown; alias?: unknown };
    if (typeof ref.name === "string") {
      name = ref.name;
      alias = typeof ref.alias === "string" ? ref.alias : undefined;
    }
  }
  if (!name) return undefined;
  const instance =
    alias && alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(alias, name)
      : (ctx.moduleContext.resourceInstances.get(name)?.instance as ResourceInstance | undefined);
  return instance ?? undefined;
}

/** Expand a mapping node against a CEL scope. `self`-only CEL resolves to
 *  literals now; a pure `self.<path>` access is navigated directly so live
 *  instances pass through (CEL's output type checker rejects them). Shared by
 *  `base:` (construction, scope `{ self }`) and the dispatch mappings
 *  `inputs:` / `result:` (scope `{ self, inputs }` / `{ self, result }`). */
function expandMappingNode(
  value: unknown,
  scope: Record<string, unknown>,
  ctx: EvaluationContext,
): unknown {
  if (isCompiledValue(value)) {
    const src = typeof value.source === "string" ? value.source.trim() : "";
    const m = src.match(SELF_PATH);
    if (m) {
      let cur: unknown = scope.self;
      for (const key of m[1].split(".").slice(1)) {
        cur = (cur as Record<string, unknown> | undefined)?.[key];
      }
      return cur;
    }
    return ctx.expandWith(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => expandMappingNode(v, scope, ctx));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandMappingNode(v, scope, ctx);
    }
    return out;
  }
  return value;
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
        ? (expandMappingNode(inputsMapping, { self, inputs }, ctx) as Record<string, unknown>)
        : inputs;
    const result = await original(mappedInputs, ...rest);
    return resultMapping != null
      ? expandMappingNode(resultMapping, { self, result }, ctx)
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
  definingContext: EvaluationContext,
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

  // Top-level reference fields on the author-facing schema — resolved to live
  // instances before `base:` runs so a `!cel "self.<ref>"` passthrough forwards
  // the live parent instance (e.g. a `client` into an inherited Http.Request).
  const refFieldPaths: string[] = [];
  for (const [path, entry] of buildReferenceFieldMap(authorSchema)) {
    if (isRefEntry(entry) && !path.includes(".") && !path.includes("[")) refFieldPaths.push(path);
  }

  return {
    create: async (resource: any, ctx: ResourceContext): Promise<ResourceInstance | null> => {
      const self: Record<string, unknown> = { ...resource, name: resource.metadata.name };
      for (const path of refFieldPaths) {
        const raw = (resource as Record<string, unknown>)[path];
        if (raw == null) continue;
        const live = resolveRefSlot(raw, ctx);
        // A reference that is set but hasn't resolved yet means the dependency
        // isn't initialized — defer via the retry signal, like _createInstance.
        if (!live) return null;
        self[path] = live;
      }

      // With `base:`, it maps `self` onto the parent's (narrowed) config. Without
      // it, the child is a pure additive extension: it carries the parent's config
      // fields directly, so forward them (reference slots already resolved to live
      // instances in `self`), minus the reserved keys.
      let parentConfig: Record<string, unknown>;
      if (base != null) {
        parentConfig = expandMappingNode(base, { self }, definingContext) as Record<string, unknown>;
      } else {
        const { kind: _kind, metadata: _metadata, name: _name, ...config } = self;
        parentConfig = config;
      }
      const parentResource: Record<string, unknown> = {
        kind: parentKind,
        metadata: { ...resource.metadata },
        ...parentConfig,
      };
      const host = ctx as unknown as InheritedInstanceHost;
      if (typeof (host as { createInheritedInstance?: unknown }).createInheritedInstance !== "function") {
        throw new Error(
          `Telo.Definition '${definition.metadata.name}': inherited controller requires a ResourceContext host that implements createInheritedInstance().`,
        );
      }
      const instance = await host.createInheritedInstance(definingContext, parentResource);
      if (!instance) return null;
      bindDispatchMapping(instance, definition, self, definingContext);
      return instance;
    },
  };
}

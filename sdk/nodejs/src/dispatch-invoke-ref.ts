import type { InvokeContext } from "./cancellation.js";
import type { Invocable } from "./capabilities/invokable.js";
import type { ModuleContext } from "./module-context.js";
import type { KindRef } from "./ref.js";
import { resolveRefInstance, type RefResolveContext } from "./resolve-ref-instance.js";
import { getRefIdentity, type ResourceInstance } from "./resource-instance.js";

/** The context a decorator kind composes to dispatch its wrapped target. */
export interface DispatchContext extends RefResolveContext {
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<unknown>;
  readonly moduleContext: ModuleContext;
  /**
   * Normalize a slot value to a {@link KindRef}: a `!ref` sentinel, an inline
   * definition, or an already-normalized ref. Optional only so a caller holding
   * a hand-built context still satisfies the interface — supply it whenever the
   * slot can hold a value Phase 2.5 did not rewrite, which is every slot inside
   * an `x-telo-scope` array.
   */
  ensureKindRef?(value: unknown): KindRef;
}

/**
 * Resolve a decorator's `invoke:` field to a live invocable and return a thunk
 * that dispatches it through the traced chokepoint. The field is either a
 * Phase-5-injected instance or a raw `{ kind, name, alias }` ref resolved
 * against the module context. Resolution is eager (fail-fast on a bad ref);
 * dispatch is deferred, so a caller can run it synchronously (Cache.View) or
 * detached (Run.Detach). `describe` labels the error with the owning resource.
 * The thunk's optional second argument seeds the dispatch's {@link InvokeContext}
 * (e.g. a decorator-owned cancellation scope); when omitted the ambient
 * invocation context applies unchanged.
 */
export function resolveInvocableDispatcher(
  field: unknown,
  ctx: DispatchContext,
  describe: () => string,
): (inputs: Record<string, unknown>, invokeCtx?: InvokeContext) => Promise<unknown> {
  // A `!ref` inside an `x-telo-scope` array is never rewritten by Phase 2.5, so it
  // arrives as the raw sentinel — which has no `name` and would otherwise fail with
  // a message pointing nowhere. `ensureKindRef` is the same rescue `ctx.resolveRef`
  // performs; both resolution paths have to normalize, or a slot works only
  // depending on which one its kind happens to use.
  const normalized =
    ctx.ensureKindRef && field !== null && typeof field === "object" && !isInvocableInstance(field)
      ? ctx.ensureKindRef(field)
      : field;
  const target = resolveRefInstance(
    normalized,
    ctx,
    isInvocableInstance,
    () => `${describe()}: 'invoke'`,
    "Telo.Invocable",
  );
  // Dispatch through the traced chokepoint needs the target's kind+name: from
  // the `!ref` identity the kernel stamped at injection, else from the ref.
  const id = getRefIdentity(target as object) ?? (normalized as Partial<KindRef> | undefined);
  if (!id || typeof id.kind !== "string" || typeof id.name !== "string") {
    return (inputs, invokeCtx) => target.invoke(inputs, invokeCtx);
  }
  const { kind, name } = id;
  return (inputs, invokeCtx) => ctx.invokeResolved(kind, name, target, inputs, invokeCtx);
}

function isInvocableInstance(value: unknown): value is ResourceInstance & Invocable {
  return typeof (value as Invocable | undefined)?.invoke === "function";
}

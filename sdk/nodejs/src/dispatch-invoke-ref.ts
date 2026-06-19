import type { Invocable } from "./capabilities/invokable.js";
import type { ModuleContext } from "./module-context.js";
import { getRefIdentity, type ResourceInstance } from "./resource-instance.js";

/** The context a decorator kind composes to dispatch its wrapped target. */
export interface DispatchContext {
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<unknown>;
  readonly moduleContext: ModuleContext;
}

/**
 * Resolve a decorator's `invoke:` field to a live invocable and return a thunk
 * that dispatches it through the traced chokepoint. The field is either a
 * Phase-5-injected instance or a raw `{ kind, name, alias }` ref resolved
 * against the module context. Resolution is eager (fail-fast on a bad ref);
 * dispatch is deferred, so a caller can run it synchronously (Cache.View) or
 * detached (Run.Detach). `describe` labels the error with the owning resource.
 */
export function resolveInvocableDispatcher(
  field: unknown,
  ctx: DispatchContext,
  describe: () => string,
): (inputs: Record<string, unknown>) => Promise<unknown> {
  if (field && typeof (field as Invocable).invoke === "function") {
    const instance = field as ResourceInstance & Invocable;
    const id = getRefIdentity(field as object);
    return (inputs) =>
      id ? ctx.invokeResolved(id.kind, id.name, instance, inputs) : instance.invoke(inputs);
  }
  const ref = field as { kind: string; name: string; alias?: string } | undefined;
  if (!ref || typeof ref.name !== "string") {
    throw new Error(`${describe()}: 'invoke' must reference an invocable.`);
  }
  const resolved = (
    ref.alias && ref.alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name)
      : ctx.moduleContext.getInstance(ref.name)
  ) as ResourceInstance | undefined;
  if (!resolved || typeof resolved.invoke !== "function") {
    throw new Error(`${describe()}: 'invoke' reference '${ref.name}' did not resolve to an invocable.`);
  }
  return (inputs) => ctx.invokeResolved(ref.kind, ref.name, resolved, inputs);
}

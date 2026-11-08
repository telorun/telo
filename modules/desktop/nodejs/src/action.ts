import { resolveInvocableDispatcher, type ResourceContext } from "@telorun/sdk";

export interface Action {
  invoke: unknown;
  inputs?: Record<string, unknown>;
}

/** Dispatches an action as an inbound trigger; a failure is logged and the caller carries on. */
export async function runAction(ctx: ResourceContext, action: Action, describe: string): Promise<void> {
  try {
    const inputs = (ctx.expandValue(action.inputs ?? {}, {}) ?? {}) as Record<string, unknown>;
    const dispatch = resolveInvocableDispatcher(action.invoke, ctx, () => describe);
    await dispatch(inputs, ctx.rootContext());
  } catch (err) {
    ctx.log.error("Action failed", { "desktop.action": describe }, { error: err });
  }
}

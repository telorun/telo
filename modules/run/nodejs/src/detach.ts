import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { resolveInvocableDispatcher } from "@telorun/sdk";

interface DetachResource {
  metadata: { name: string; module?: string };
  invoke?: unknown;
}

/**
 * Generic fire-and-forget: dispatches the wrapped `invoke:` target via
 * `ctx.runDetached` and returns immediately. The kernel tracks the task against
 * this resource and drains it when the resource tears down; a failure is routed
 * to the EventBus (the caller never blocks on, or sees, the detached work).
 */
class RunDetach implements ResourceInstance {
  constructor(
    private readonly resource: DetachResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: Record<string, unknown>): Promise<{ detached: true }> {
    const dispatch = resolveInvocableDispatcher(
      this.resource.invoke,
      this.ctx,
      () => `Run.Detach "${this.resource.metadata.name}"`,
    );
    this.ctx.runDetached(() => dispatch(inputs));
    return { detached: true };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: DetachResource, ctx: ResourceContext): Promise<RunDetach> {
  return new RunDetach(resource, ctx);
}

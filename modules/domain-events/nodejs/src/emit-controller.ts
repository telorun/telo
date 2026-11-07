import {
  InvokeError,
  isCancellationError,
  isInvokeError,
  isSuspension,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface EmitResource {
  event: { name: string };
}

/**
 * Domain.Emit — runs every handler of its event one at a time, inside this
 * invocation, and wraps a handler's failure. The set is asked of the kernel at
 * each call, so a handler a reconcile added is reached by the next emit.
 */
class DomainEmit implements ResourceInstance {
  constructor(
    private readonly resource: EmitResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(payload: unknown, invokeCtx: InvokeContext): Promise<Record<string, never>> {
    const event = this.resource.event.name;
    for (const { target, instance } of this.ctx.resolveCoReferrers("/event")) {
      try {
        await this.ctx.invokeResolved(target.ref.kind, target.ref.name, instance, payload, invokeCtx);
      } catch (err) {
        if (isCancellationError(err) || isSuspension(err)) throw err;
        const handler = target.ref.name;
        const reason = err instanceof Error ? err.message : String(err);
        throw new InvokeError(
          "ERR_DOMAIN_EVENT_HANDLER_FAILED",
          `Handler '${handler}' of event '${event}' failed: ${reason}`,
          { event, handler },
          { cause: err, displayMessage: isInvokeError(err) ? err.displayMessage : undefined },
        );
      }
    }
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: EmitResource, ctx: ResourceContext): Promise<DomainEmit> {
  return new DomainEmit(resource, ctx);
}

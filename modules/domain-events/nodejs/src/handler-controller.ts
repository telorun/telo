import {
  predicateResult,
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

interface HandlerResource {
  metadata: { name: string };
  when?: unknown;
  invoke: unknown;
  inputs?: Record<string, unknown>;
}

/**
 * Domain.Handler — evaluates `when` and `inputs` over `event` (the payload it
 * was invoked with) and calls its target, discarding the result.
 */
class DomainHandler implements ResourceInstance {
  private readonly dispatch: ReturnType<typeof resolveInvocableDispatcher>;

  constructor(
    private readonly resource: HandlerResource,
    private readonly ctx: ResourceContext,
  ) {
    this.dispatch = resolveInvocableDispatcher(
      resource.invoke,
      ctx,
      () => `Domain.Handler "${resource.metadata.name}": 'invoke'`,
    );
  }

  async invoke(payload: unknown, invokeCtx: InvokeContext): Promise<Record<string, never>> {
    const scope = { event: payload };
    if (
      this.resource.when !== undefined &&
      !predicateResult(this.ctx.expandValue(this.resource.when, scope), `Domain.Handler "${this.resource.metadata.name}".when`)
    ) {
      return {};
    }
    const inputs = this.ctx.expandValue(this.resource.inputs ?? {}, scope) ?? {};
    await this.dispatch(inputs as Record<string, unknown>, invokeCtx);
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: HandlerResource, ctx: ResourceContext): Promise<DomainHandler> {
  return new DomainHandler(resource, ctx);
}

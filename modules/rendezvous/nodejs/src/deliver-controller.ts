import type {
  InvokeContext,
  KindRef,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { isRendezvousPoint, type RendezvousPoint } from "./rendezvous-point-contract.js";

interface DeliverResource {
  metadata: { name: string; module?: string };
  point?: RendezvousPoint | KindRef<RendezvousPoint>;
}

interface DeliverInputs {
  key: string;
  payload: unknown;
}

/** Rendezvous.Deliver — offer a value under a key: handed to the waiting
 *  `Await` (`delivered: true`) or held for the point's window (`false`). */
class RendezvousDeliver implements ResourceInstance<DeliverInputs, { delivered: boolean }> {
  constructor(
    private readonly resource: DeliverResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: DeliverInputs, invokeCtx?: InvokeContext): Promise<{ delivered: boolean }> {
    const point = this.ctx.resolveRef(
      this.resource.point,
      isRendezvousPoint,
      () => `Rendezvous.Deliver "${this.resource.metadata.name}": 'point'`,
      "Rendezvous.Point",
    );
    const result = await point.offer(inputs.key, inputs.payload, invokeCtx);
    return { delivered: result.outcome === "delivered" };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: DeliverResource,
  ctx: ResourceContext,
): Promise<RendezvousDeliver> {
  return new RendezvousDeliver(resource, ctx);
}

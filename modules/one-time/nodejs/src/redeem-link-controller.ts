import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundOperation, type OperationResource } from "./one-time-operation.js";

/** OneTime.RedeemLink — opens a link once. */
class RedeemLink implements ResourceInstance<{ token: string; holder?: string | null }, unknown> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: { token: string; holder?: string | null }): Promise<unknown> {
    return this.bound.links.redeemLink(inputs.token, inputs.holder);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<RedeemLink> {
  return new RedeemLink(new BoundOperation("OneTime.RedeemLink", resource, ctx));
}

export function register(): void {}

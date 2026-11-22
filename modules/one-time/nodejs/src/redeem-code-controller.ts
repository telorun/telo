import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundOperation, type OperationResource } from "./one-time-operation.js";

/** OneTime.RedeemCode — checks a typed code for a subject. */
class RedeemCode implements ResourceInstance<{ subject: string; token: string; holder?: string | null }, unknown> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: { subject: string; token: string; holder?: string | null }): Promise<unknown> {
    return this.bound.codes.redeemCode(inputs.subject, inputs.token, inputs.holder);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<RedeemCode> {
  return new RedeemCode(new BoundOperation("OneTime.RedeemCode", resource, ctx));
}

export function register(): void {}

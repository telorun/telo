import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundOperation, type OperationResource } from "./one-time-operation.js";

/** OneTime.Revoke — withdraws a subject's live token. */
class Revoke implements ResourceInstance<{ subject: string }, unknown> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: { subject: string }): Promise<unknown> {
    return { revoked: await this.bound.tokens.revoke(inputs.subject) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Revoke> {
  return new Revoke(new BoundOperation("OneTime.Revoke", resource, ctx));
}

export function register(): void {}

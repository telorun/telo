import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundKeyOperation, type OperationResource } from "./key-operation.js";
import { storeInconsistent } from "./store-failure.js";

interface RevokeInputs {
  id: string;
  by?: string | null;
}

/** ApiKey.Revoke — set the key's revocation; repeating it changes nothing and answers the first. */
class Revoke implements ResourceInstance<RevokeInputs, Record<string, unknown>> {
  constructor(private readonly bound: BoundKeyOperation) {}

  async invoke(inputs: RevokeInputs, invokeCtx?: InvokeContext): Promise<Record<string, unknown>> {
    const uuid = this.bound.uuidOf(inputs.id);
    const store = this.bound.store;
    const outcome = await this.bound.call(() => store.revoke(uuid, { by: inputs.by ?? null }, invokeCtx));
    switch (outcome.outcome) {
      case "revoked":
      case "alreadyRevoked":
        return { id: inputs.id, revokedAt: outcome.key.revokedAt, revokedBy: outcome.key.revokedBy };
      case "absent":
        throw this.bound.notFound(inputs.id);
      default:
        throw storeInconsistent(this.bound.describe, `${JSON.stringify(outcome)} for a revoke`);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<Revoke> {
  return new Revoke(new BoundKeyOperation("ApiKey.Revoke", resource, ctx));
}

export function register(): void {}

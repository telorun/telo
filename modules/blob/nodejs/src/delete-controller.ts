import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { BoundOperation, type OperationResource } from "./operation-binding.js";

interface DeleteInputs {
  key: string;
}

interface DeleteOutputs {
  key: string;
}

/** Blob.Delete — remove a stored blob; a key holding nothing succeeds. */
class BlobDelete implements ResourceInstance<DeleteInputs, DeleteOutputs> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: DeleteInputs, ctx?: InvokeContext): Promise<DeleteOutputs> {
    await this.bound.store.delete(inputs.key, ctx);
    return { key: inputs.key };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: OperationResource,
  ctx: ResourceContext,
): Promise<BlobDelete> {
  return new BlobDelete(new BoundOperation("Blob.Delete", resource, ctx));
}

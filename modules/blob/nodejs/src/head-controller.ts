import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  blobNotFound,
  BoundOperation,
  reducedContentType,
  type OperationResource,
} from "./operation-binding.js";

interface HeadInputs {
  key: string;
}

interface HeadOutputs {
  size: number;
  contentType: string;
}

/** Blob.Head — a stored blob's size and media type, its content unread. */
class BlobHead implements ResourceInstance<HeadInputs, HeadOutputs> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: HeadInputs, ctx?: InvokeContext): Promise<HeadOutputs> {
    const outcome = await this.bound.store.head(inputs.key, ctx);
    if (outcome.status === "absent") throw blobNotFound(this.bound.describe, inputs.key);
    return { size: outcome.size, contentType: reducedContentType(outcome.contentType) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<BlobHead> {
  return new BlobHead(new BoundOperation("Blob.Head", resource, ctx));
}

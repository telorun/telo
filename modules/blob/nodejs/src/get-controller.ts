import {
  InvokeError,
  Stream,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  blobNotFound,
  BoundOperation,
  boundInput,
  reducedContentType,
  type OperationResource,
} from "./operation-binding.js";

interface GetInputs {
  key: string;
  maxBytes?: unknown;
}

interface GetOutputs {
  output: Stream<Uint8Array>;
  size: number;
  contentType: string;
}

/** Blob.Get — a stored blob as a byte stream, with its size and media type. */
class BlobGet implements ResourceInstance<GetInputs, GetOutputs> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: GetInputs, ctx?: InvokeContext): Promise<GetOutputs> {
    const { key } = inputs;
    const maxBytes = boundInput(inputs.maxBytes);
    const found = await this.bound.store.get(key, ctx);
    if (found.status === "absent") throw blobNotFound(this.bound.describe, key);
    if (maxBytes !== undefined && found.size > maxBytes) {
      // Released unread: the refusal is decided from the size alone.
      try {
        await found.content[Symbol.asyncIterator]().return?.();
      } catch (err) {
        this.bound.log.warn("Content not released", { "blob.key": key }, { error: err });
      }
      throw new InvokeError(
        "ERR_BLOB_TOO_LARGE",
        `${this.bound.describe}: the blob under '${key}' is ${found.size} bytes, over the ${maxBytes} bytes 'maxBytes' allows; it was not read.`,
        { key, size: found.size, maxBytes },
      );
    }
    return {
      output: new Stream(found.content),
      size: found.size,
      contentType: reducedContentType(found.contentType),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<BlobGet> {
  return new BlobGet(new BoundOperation("Blob.Get", resource, ctx));
}

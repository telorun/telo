import { InvokeError, type KindRef, type Logger, type ResourceContext } from "@telorun/sdk";
import { isBlobStore, type BlobStore } from "./blob-store-contract.js";

export interface OperationResource {
  metadata: { name: string; module?: string };
  store?: BlobStore | KindRef<BlobStore>;
}

/** One operation resource: its label for messages, and the store its `store`
 *  slot names — resolved per call, so creation orders against nothing. */
export class BoundOperation {
  readonly describe: string;

  constructor(
    kind: string,
    private readonly resource: OperationResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  get log(): Logger {
    return this.ctx.log;
  }

  get store(): BlobStore {
    return this.ctx.resolveRef(
      this.resource.store,
      isBlobStore,
      () => `${this.describe}: 'store'`,
      "Blob.Store",
    );
  }
}

/** A byte bound read from a call's inputs: a literal arrives as a number, a
 *  computed one as an int64. */
export function boundInput(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : Number(value);
}

export function blobNotFound(describe: string, key: string): InvokeError {
  return new InvokeError("ERR_BLOB_NOT_FOUND", `${describe}: no blob is stored under '${key}'.`, {
    key,
  });
}

export const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

/** What a store's medium recorded, as the one vocabulary the operations speak:
 *  parameters dropped, lower-cased, and the unknown type for anything that is
 *  still not `type/subtype`. */
export function reducedContentType(recorded: unknown): string {
  if (typeof recorded !== "string") return UNKNOWN_MEDIA_TYPE;
  const bare = recorded.split(";", 1)[0].trim().toLowerCase();
  return MEDIA_TYPE.test(bare) ? bare : UNKNOWN_MEDIA_TYPE;
}

import type { InvokeContext } from "@telorun/sdk";

/**
 * The `Blob.Store` contract (normative: `docs/store-contract.md`).
 *
 * A store stores. It knows no bound and computes nothing: counting, hashing,
 * the byte limit and every error code are the operation kinds', decided once
 * for every backend. A failure — a lost connection, a full disk — is thrown as
 * it arrives.
 *
 * Every method takes the calling invocation's context last, so a remote call
 * can be cancelled with it; a local store may ignore it.
 */
export interface BlobStore {
  /** Store `content` under `key`, replacing what is there in one atomic step.
   *  Nothing is stored unless the whole source was read; a source failure is
   *  rethrown as it was raised, with nothing staged left behind. The source is
   *  not the store's to release: the operation that made the call releases it. */
  put(
    key: string,
    content: AsyncIterable<Uint8Array>,
    options: BlobPutOptions,
    ctx?: InvokeContext,
  ): Promise<void>;
  /** The blob under `key`, its content read only as it is iterated. Leaves
   *  nothing open: the content opens the read at its first pull. */
  get(key: string, ctx?: InvokeContext): Promise<BlobContent | BlobAbsent>;
  /** The size and media type of the blob under `key`. */
  head(key: string, ctx?: InvokeContext): Promise<BlobFound | BlobAbsent>;
  /** Remove the blob under `key`. A key holding nothing is not a failure. */
  delete(key: string, ctx?: InvokeContext): Promise<void>;
}

export interface BlobPutOptions {
  /** Lower-case `type/subtype`, no parameters. */
  contentType: string;
}

export interface BlobFound {
  status: "found";
  size: number;
  /** What the medium records, verbatim. */
  contentType: string;
}

export interface BlobContent extends BlobFound {
  /** Single-use. The first pull delivers the blob that was described, or
   *  fails. `return()` is safe before the first pull, where there is nothing to
   *  release, and releases what the read holds after it. */
  content: AsyncIterable<Uint8Array>;
}

export interface BlobAbsent {
  status: "absent";
}

const METHODS = ["put", "get", "head", "delete"] as const;

/** A store is recognised by its four methods and nothing else — never by its
 *  class, and never by having imported this file: a backend may live in another
 *  module, another repository, or another bundle. */
export function isBlobStore(value: unknown): value is BlobStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return METHODS.every((method) => typeof candidate[method] === "function");
}

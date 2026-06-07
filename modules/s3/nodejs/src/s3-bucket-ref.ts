import { InvokeError } from "@telorun/sdk";
import type { S3BucketResource } from "./s3-bucket-controller.js";

/**
 * Returns the live S3.Bucket the kernel injected into a `bucketRef` slot
 * (x-telo-ref "std/s3#Bucket"). The reference resolves uniformly whether the
 * bucket is declared in the same module or exported by an imported library
 * (`!ref Alias.name`). Throws ERR_INVALID_REFERENCE when the slot did not
 * resolve to a live bucket instance.
 */
export function resolveBucket(bucketRef: S3BucketResource | undefined): S3BucketResource {
  if (!bucketRef || typeof bucketRef.getClient !== "function") {
    throw new InvokeError(
      "ERR_INVALID_REFERENCE",
      "S3 bucketRef did not resolve to a live S3.Bucket instance",
    );
  }
  return bucketRef;
}

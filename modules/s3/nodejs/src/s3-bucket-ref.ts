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

/** The S3.Bucket client is shared across every S3 controller. When controllers
 *  are bundled separately (`telo install`), each inlines its own copy of
 *  `@aws-sdk/client-s3`, so an error thrown by the shared client is NOT an
 *  `instanceof S3ServiceException` in a different controller's bundle. Classify
 *  such errors by their structural fields (`name` / `$metadata.httpStatusCode`)
 *  — which the SDK always sets — rather than by class identity. */
export function s3ErrorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null
    ? (err as { name?: string }).name
    : undefined;
}

export function s3ErrorStatus(err: unknown): number | undefined {
  return typeof err === "object" && err !== null
    ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
}

/** Structural "resource does not exist" check — a missing object (`NoSuchKey`)
 *  or bucket (`NotFound`), or any 404. Dual-realm safe (see above). */
export function isS3NotFound(err: unknown): boolean {
  const name = s3ErrorName(err);
  return name === "NoSuchKey" || name === "NotFound" || s3ErrorStatus(err) === 404;
}

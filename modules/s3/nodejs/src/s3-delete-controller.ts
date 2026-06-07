import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";
import { resolveBucket } from "./s3-bucket-ref.js";

interface S3DeleteManifest {
  // x-telo-ref "std/s3#Bucket": Phase 5 injects the live S3.Bucket instance here.
  bucketRef: S3BucketResource;
}

interface S3DeleteInputs {
  key: string;
}

interface S3DeleteOutput {
  key: string;
}

/**
 * Delete an object from a bucket. S3 delete is idempotent — removing a key that
 * does not exist succeeds — so the only error surfaced here is an unresolvable
 * `bucketRef`, mirroring `S3.Get`.
 */
class S3DeleteResource implements ResourceInstance<S3DeleteInputs, S3DeleteOutput> {
  constructor(
    private readonly manifest: S3DeleteManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: S3DeleteInputs): Promise<S3DeleteOutput> {
    const bucket = resolveBucket(this.manifest.bucketRef);

    await bucket.getClient().send(
      new DeleteObjectCommand({ Bucket: bucket.bucketName, Key: input.key }),
    );

    return { key: input.key };
  }
}

export function register(): void {}

export async function create(
  resource: S3DeleteManifest,
  ctx: ResourceContext,
): Promise<S3DeleteResource> {
  return new S3DeleteResource(resource, ctx);
}

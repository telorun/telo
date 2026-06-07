import { ListObjectsCommand } from "@aws-sdk/client-s3";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";
import { resolveBucket } from "./s3-bucket-ref.js";

interface S3ListManifest {
  // x-telo-ref "std/s3#Bucket": Phase 5 injects the live S3.Bucket instance here.
  bucketRef: S3BucketResource;
}

class S3ListResource implements ResourceInstance {
  constructor(
    private readonly manifest: S3ListManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: any): Promise<{ keys: string[] }> {
    const prefix = (input?.prefix as string) ?? "";

    const bucket = resolveBucket(this.manifest.bucketRef);

    const client = bucket.getClient();
    const result = await client.send(
      new ListObjectsCommand({ Bucket: bucket.bucketName as string, Prefix: prefix }),
    );

    const keys = (result.Contents ?? []).map((obj) => obj.Key ?? "");
    return { keys };
  }
}

export function register(): void {}

export async function create(
  resource: S3ListManifest,
  ctx: ResourceContext,
): Promise<S3ListResource> {
  return new S3ListResource(resource, ctx);
}

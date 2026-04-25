import { ListObjectsCommand } from "@aws-sdk/client-s3";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";

interface S3ListManifest {
  bucketRef: { name: string };
}

class S3ListResource implements ResourceInstance {
  constructor(
    private readonly manifest: S3ListManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: any): Promise<{ keys: string[] }> {
    const ctx = this.ctx;
    const m = this.manifest;
    const bucketRefName = ctx.expandValue(m.bucketRef.name, input ?? {}) as string;
    const prefix = (input?.prefix as string) ?? "";

    const bucket: S3BucketResource = ctx.moduleContext.getInstance(bucketRefName) as any;
    if (!bucket) {
      throw new Error(`S3.Bucket "${bucketRefName}" not found`);
    }

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

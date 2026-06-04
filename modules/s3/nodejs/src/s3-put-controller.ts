import { PutObjectCommand } from "@aws-sdk/client-s3";
import { InvokeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";

interface S3PutManifest {
  bucketRef: { name: string };
}

class S3PutResource implements ResourceInstance {
  constructor(
    private readonly manifest: S3PutManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: {
    key: string;
    body: string | Uint8Array;
    contentType?: string;
  }): Promise<{ key: string }> {
    if (typeof input.body !== "string" && !(input.body instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `S3.Put "body" must be a string or Uint8Array; got ${typeof input.body}.`,
      );
    }

    const bucketRefName = this.ctx.expandValue(this.manifest.bucketRef.name, input ?? {}) as string;

    const bucket = this.ctx.moduleContext.getInstance(bucketRefName) as S3BucketResource | undefined;
    if (!bucket) {
      throw new InvokeError("ERR_INVALID_REFERENCE", `S3.Bucket "${bucketRefName}" not found`);
    }

    await bucket.getClient().send(
      new PutObjectCommand({
        Bucket: bucket.bucketName,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType ?? "application/octet-stream",
      }),
    );

    return { key: input.key };
  }
}

export function register(): void {}

export async function create(
  resource: S3PutManifest,
  ctx: ResourceContext,
): Promise<S3PutResource> {
  return new S3PutResource(resource, ctx);
}

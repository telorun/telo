import { S3Client } from "@aws-sdk/client-s3";
import { Static, Type } from "@sinclair/typebox";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

export const schema = Type.Object({
  bucketName: Type.String(),
  endpoint: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
});
export type S3BucketManifest = Static<typeof schema>;

export class S3BucketResource implements ResourceInstance {
  readonly client: S3Client;
  readonly bucketName: string;

  constructor(manifest: S3BucketManifest) {
    this.bucketName = manifest.bucketName;
    this.client = new S3Client({
      region: "auto",
      endpoint: manifest.endpoint,
      credentials: { accessKeyId: manifest.accessKeyId, secretAccessKey: manifest.secretAccessKey },
    });
  }

  getClient() {
    return this.client;
  }

  snapshot() {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: S3BucketManifest,
  ctx: ResourceContext,
): Promise<S3BucketResource> {
  ctx.validateSchema(resource, schema);
  return new S3BucketResource(resource);
}

import {
  CreateBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Static, Type } from "@sinclair/typebox";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

export const schema = Type.Object({
  bucketName: Type.String(),
  endpoint: Type.String(),
  accessKeyId: Type.String(),
  secretAccessKey: Type.String(),
  forcePathStyle: Type.Optional(Type.Boolean()),
  createIfMissing: Type.Optional(Type.Boolean()),
  publicRead: Type.Optional(Type.Boolean()),
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
      forcePathStyle: manifest.forcePathStyle ?? false,
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
  const instance = new S3BucketResource(resource);
  if (resource.createIfMissing) {
    await ensureBucket(instance);
  }
  if (resource.publicRead) {
    await applyPublicReadPolicy(instance);
  }
  return instance;
}

async function ensureBucket(instance: S3BucketResource): Promise<void> {
  try {
    await instance.getClient().send(new CreateBucketCommand({ Bucket: instance.bucketName }));
  } catch (err) {
    if (err instanceof S3ServiceException) {
      if (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists") {
        return;
      }
    }
    throw err;
  }
}

async function applyPublicReadPolicy(instance: S3BucketResource): Promise<void> {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${instance.bucketName}/*`,
      },
    ],
  };
  await instance.getClient().send(
    new PutBucketPolicyCommand({
      Bucket: instance.bucketName,
      Policy: JSON.stringify(policy),
    }),
  );
}

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { InvokeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";
import { resolveBucket } from "./s3-bucket-ref.js";

// SigV4 query presigning caps expiry at 7 days.
const MAX_EXPIRES_IN = 604800;

type PresignOperation = "get" | "put";

interface S3PresignedUrlManifest {
  // x-telo-ref "std/s3#Bucket": Phase 5 injects the live S3.Bucket instance here.
  bucketRef: S3BucketResource;
  operation?: PresignOperation;
  expiresIn?: number;
}

interface S3PresignedUrlInputs {
  key: string;
  operation?: PresignOperation;
  expiresIn?: number;
  contentType?: string;
}

interface S3PresignedUrlOutput {
  url: string;
  expiresAt: string;
}

/**
 * Produces a time-limited URL for an object via SigV4 query presigning — GET
 * for downloads, PUT for browser-direct uploads. Pure local crypto — no
 * request leaves the process, and the object's existence is not checked; a
 * GET URL for a missing key simply 404s when used.
 */
class S3PresignedUrlResource implements ResourceInstance<S3PresignedUrlInputs, S3PresignedUrlOutput> {
  constructor(private readonly manifest: S3PresignedUrlManifest) {}

  async invoke(input: S3PresignedUrlInputs): Promise<S3PresignedUrlOutput> {
    const bucket = resolveBucket(this.manifest.bucketRef);
    const key = input?.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `S3.PresignedUrl: 'key' must be a non-empty string; got ${typeof key}.`,
      );
    }
    const operation = input.operation ?? this.manifest.operation ?? "get";
    if (operation !== "get" && operation !== "put") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `S3.PresignedUrl: 'operation' must be "get" or "put"; got ${JSON.stringify(operation)}.`,
      );
    }
    if (input.contentType !== undefined && operation !== "put") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `S3.PresignedUrl: 'contentType' only applies to the "put" operation; the signed GET response type is the object's own.`,
      );
    }
    const expiresIn = input.expiresIn ?? this.manifest.expiresIn ?? 900;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES_IN) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `S3.PresignedUrl: 'expiresIn' must be an integer between 1 and ${MAX_EXPIRES_IN} seconds; got ${expiresIn}.`,
      );
    }

    const command =
      operation === "put"
        ? new PutObjectCommand({
            Bucket: bucket.bucketName,
            Key: key,
            ContentType: input.contentType,
          })
        : new GetObjectCommand({ Bucket: bucket.bucketName, Key: key });
    const url = await getSignedUrl(bucket.getClient(), command, {
      expiresIn,
      // The presigner signs only `host` by default — without this, the
      // declared Content-Type would not be enforced on the uploader.
      ...(input.contentType !== undefined && { signableHeaders: new Set(["content-type"]) }),
    });
    return { url, expiresAt: expiresAtFromUrl(url, expiresIn) };
  }
}

/** The URL's true expiry is its signed X-Amz-Date + X-Amz-Expires — read it
 *  back so the reported timestamp is exact, not a pre-signing approximation. */
function expiresAtFromUrl(url: string, expiresIn: number): string {
  const params = new URL(url).searchParams;
  const amzDate = params.get("X-Amz-Date");
  const amzExpires = Number(params.get("X-Amz-Expires") ?? expiresIn);
  const m = amzDate?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const signedAt = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
    : Date.now();
  return new Date(signedAt + amzExpires * 1000).toISOString();
}

export function register(): void {}

export async function create(
  resource: S3PresignedUrlManifest,
  ctx: ResourceContext,
): Promise<S3PresignedUrlResource> {
  return new S3PresignedUrlResource(resource);
}

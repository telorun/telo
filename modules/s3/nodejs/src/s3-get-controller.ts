import { GetObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { InvokeError, Stream, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { S3BucketResource } from "./s3-bucket-controller.js";
import { resolveBucket } from "./s3-bucket-ref.js";

interface S3GetManifest {
  // x-telo-ref "std/s3#Bucket": Phase 5 injects the live S3.Bucket instance here.
  bucketRef: S3BucketResource;
}

interface S3GetInputs {
  key: string;
}

interface S3GetOutput {
  output: Stream<Uint8Array>;
  contentType?: string;
}

class S3GetResource implements ResourceInstance<S3GetInputs, S3GetOutput> {
  constructor(
    private readonly manifest: S3GetManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: S3GetInputs): Promise<S3GetOutput> {
    const bucket = resolveBucket(this.manifest.bucketRef);

    let response;
    try {
      response = await bucket.getClient().send(
        new GetObjectCommand({ Bucket: bucket.bucketName, Key: input.key }),
      );
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404)
      ) {
        throw new InvokeError("ERR_NOT_FOUND", `S3 object not found: ${input.key}`);
      }
      throw err;
    }

    const body = response.Body;
    if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_RESPONSE",
        `S3 GetObject returned no iterable body for key '${input.key}'.`,
      );
    }

    return {
      output: new Stream(toUint8ArrayIterable(body as AsyncIterable<Uint8Array | Buffer>)),
      contentType: response.ContentType,
    };
  }
}

async function* toUint8ArrayIterable(
  source: AsyncIterable<Uint8Array | Buffer>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
}

export function register(): void {}

export async function create(
  resource: S3GetManifest,
  ctx: ResourceContext,
): Promise<S3GetResource> {
  return new S3GetResource(resource, ctx);
}

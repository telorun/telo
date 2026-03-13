import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

interface S3BucketManifest {
  bucketName: string;
  endpoint: string;
}

class S3BucketResource implements ResourceInstance {
  readonly metadata: { name: string; module: string; [key: string]: any };

  constructor(private readonly manifest: any) {
    this.metadata = manifest.metadata ?? {};
  }

  snapshot() {
    return {
      bucketName: this.manifest.bucketName,
      endpoint: this.manifest.endpoint,
    };
  }
}

export function register(): void {}

export async function create(
  resource: S3BucketManifest,
  _ctx: ResourceContext,
): Promise<S3BucketResource> {
  return new S3BucketResource(resource);
}

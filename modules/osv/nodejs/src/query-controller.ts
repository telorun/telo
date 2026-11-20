import { AdvisoryLookupError, DEFAULT_OSV_URL, lookupAdvisories, LookupCancelledError, type ComponentInput } from "@telorun/osv";
import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  type InvokeContext,
  toPlainJson,
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
} from "@telorun/sdk";

export function register(ctx: ControllerContext): void {}

interface QueryManifest extends ResourceManifest {
  baseUrl?: unknown;
}

class OsvQueryResource implements ResourceInstance<{ components: ComponentInput[] }, unknown> {
  constructor(private readonly baseUrl: string) {}

  async invoke(inputs: { components: ComponentInput[] }, ctx?: InvokeContext): Promise<{ components: unknown[] }> {
    try {
      return {
        components: await lookupAdvisories(inputs.components, { baseUrl: this.baseUrl, signal: ctx?.cancellation.signal }),
      };
    } catch (error) {
      if (error instanceof LookupCancelledError) throw new InvokeError(ERR_INVOKE_CANCELLED, "Advisory lookup cancelled");
      if (error instanceof AdvisoryLookupError) {
        throw new InvokeError(error.code, error.message, { endpoint: error.endpoint });
      }
      throw error;
    }
  }
}

export async function create(
  resource: QueryManifest,
  ctx: ResourceContext,
): Promise<OsvQueryResource> {
  return new OsvQueryResource(resource.baseUrl === undefined ? DEFAULT_OSV_URL : (toPlainJson(resource.baseUrl) as string));
}

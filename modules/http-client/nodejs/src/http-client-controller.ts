import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

/** Applies a credential to one outgoing request. Resolved and dispatched by the
 *  client that declares the slot, so a caller never sees the ref's raw shape. */
export type CredentialApplier = (
  inputs: Record<string, unknown>,
  invokeCtx?: InvokeContext,
) => Promise<unknown>;

interface HttpClientManifest {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  followRedirects?: boolean;
  credential?: unknown;
}

class HttpClientResource implements ResourceInstance {
  readonly metadata: { name: string; module: string; [key: string]: any };
  private applier?: CredentialApplier | null;

  constructor(
    private readonly manifest: any,
    private readonly ctx: ResourceContext,
  ) {
    this.metadata = manifest.metadata ?? {};
  }

  /**
   * The credential to apply, resolved in THIS client's context — the slot is the
   * client's, so an aliased ref resolves against the module that authored it
   * rather than whichever module the request happens to live in.
   *
   * Resolved on first use rather than in the constructor, so a client created
   * before its credential is initialized does not race the init order.
   * Deliberately absent from `snapshot()`: value flow publishes what the author
   * configured, and a credential is a live collaborator, not a readable value.
   */
  credential(): CredentialApplier | undefined {
    if (this.applier === undefined) {
      this.applier = this.manifest.credential
        ? resolveInvocableDispatcher(
            this.manifest.credential,
            this.ctx,
            () => `Http.Client "${this.metadata.name ?? ""}": 'credential'`,
          )
        : null;
    }
    return this.applier ?? undefined;
  }

  snapshot() {
    return {
      baseUrl: this.manifest.baseUrl ?? "",
      headers: this.manifest.headers ?? {},
      timeout: this.manifest.timeout ?? 10000,
      followRedirects: this.manifest.followRedirects ?? true,
    };
  }
}

export function register(): void {}

export async function create(
  resource: HttpClientManifest,
  ctx: ResourceContext,
): Promise<HttpClientResource> {
  return new HttpClientResource(resource, ctx);
}

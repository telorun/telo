import {
  resolveInvocableDispatcher,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { Agent, fetch as undiciFetch } from "undici";
import { resolveConnectOptions, type TlsSettings } from "./tls-material.js";

/** What a request sends through when its client sets TLS: undici's own fetch
 *  with the client's dispatcher, so settings never touch process-wide state. */
export interface ClientTransport {
  fetch: typeof undiciFetch;
  dispatcher: Agent;
}

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
  throwOnHttpError?: boolean;
  retry?: Record<string, unknown>;
  credential?: unknown;
  tls?: TlsSettings;
}

class HttpClientResource implements ResourceInstance {
  readonly metadata: { name: string; module: string; [key: string]: any };
  private applier?: CredentialApplier | null;
  private agent?: Agent;

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

  /** Builds the TLS agent, so bad material fails the client's start rather than
   *  its first request. Absent TLS settings allocate nothing. */
  init(ctx: ResourceContext) {
    const tls = this.manifest.tls as TlsSettings | undefined;
    if (!tls) return;
    return ctx.effect("tls agent", async () => {
      const connect = resolveConnectOptions(tls);
      if (tls.insecureSkipVerify) {
        ctx.log.warn("TLS verification is disabled for this client", {
          "http.client": this.metadata.name ?? "",
        });
      }
      const agent = new Agent({ connect });
      this.agent = agent;
      return {
        result: undefined,
        inverse: async () => {
          this.agent = undefined;
          await agent.close();
        },
      };
    });
  }

  transport(): ClientTransport | undefined {
    if (!this.manifest.tls) return undefined;
    // A client that set TLS never sends without it: no agent means it is not started.
    if (!this.agent) {
      throw new Error(
        `Http.Client "${this.metadata.name ?? ""}": its TLS agent is not available (the client is not started).`,
      );
    }
    return { fetch: undiciFetch, dispatcher: this.agent };
  }

  // Policy defaults are published only when DECLARED: `undefined` is what tells a
  // request "the client said nothing here", and defaulting them would make every
  // client override a request's own setting with a value nobody wrote.
  snapshot() {
    return {
      baseUrl: this.manifest.baseUrl ?? "",
      headers: this.manifest.headers ?? {},
      timeout: this.manifest.timeout ?? 10000,
      followRedirects: this.manifest.followRedirects ?? true,
      ...(this.manifest.throwOnHttpError === undefined
        ? {}
        : { throwOnHttpError: this.manifest.throwOnHttpError }),
      ...(this.manifest.retry === undefined ? {} : { retry: this.manifest.retry }),
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

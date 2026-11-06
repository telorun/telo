import type { CookieAttributes } from "@telorun/http-dispatch";
import { RuntimeError, type ResourceInstance, type ResourceManifest } from "@telorun/sdk";
import { credentialMalformed, type CredentialRequest } from "./credential-source.js";

interface FromCookieResource extends ResourceManifest {
  /** Phase 5 injects the live `HttpDispatch.Cookie` instance. */
  cookie: ResourceInstance;
  scheme: string;
  trustedOrigins?: string[];
}

export function register(): void {}

export async function create(resource: FromCookieResource): Promise<ResourceInstance> {
  const trustedOrigins = [...(resource.trustedOrigins ?? [])];
  for (const origin of trustedOrigins) {
    if (!isOrigin(origin)) {
      throw new RuntimeError(
        "ERR_HTTP_TRUSTED_ORIGIN_INVALID",
        `Http.FromCookie[${resource.metadata.name}] lists '${origin}' in trustedOrigins, which is not an origin — ` +
          "write the scheme and host, with a port when it is not the default, and nothing after it.",
      );
    }
  }
  let name: string | undefined;
  const cookieName = async (): Promise<string> =>
    (name ??= ((await resource.cookie.snapshot!()) as CookieAttributes).name);
  return {
    async invoke(inputs: Record<string, any>) {
      const value = (inputs as CredentialRequest).cookies[await cookieName()];
      if (value === undefined) return null;
      if (value === "") throw credentialMalformed(`The ${await cookieName()} cookie is empty`);
      return { type: "token", token: value };
    },
    snapshot() {
      return { schemes: [resource.scheme], originCheck: { trustedOrigins } };
    },
  };
}

function isOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text;
  } catch {
    return false;
  }
}

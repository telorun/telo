import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { authorizationHeader, credentialMalformed, TOKEN68, type CredentialRequest } from "./credential-source.js";

interface FromAuthorizationResource extends ResourceManifest {
  schemes: string[];
}

export function register(): void {}

export async function create(resource: FromAuthorizationResource): Promise<ResourceInstance> {
  const schemes = [...resource.schemes];
  return {
    async invoke(inputs: Record<string, any>) {
      const header = authorizationHeader(inputs as CredentialRequest);
      if (!header) return null;
      const scheme = schemes.find((listed) => listed.toLowerCase() === header.scheme.toLowerCase());
      if (scheme === undefined) return null;
      if (!TOKEN68.test(header.rest)) {
        throw credentialMalformed(`The Authorization header names the ${scheme} scheme but carries no readable token`);
      }
      return { type: "token", token: header.rest, scheme };
    },
    snapshot() {
      return { schemes, ...(schemes.some((scheme) => scheme.toLowerCase() === "bearer") ? { bearerMethod: "header" } : {}) };
    },
  };
}

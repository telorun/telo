import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { singleValue, type CredentialRequest } from "./credential-source.js";

interface FromForwardedIdentityResource extends ResourceManifest {
  header: string;
  scheme: string;
}

export function register(): void {}

export async function create(resource: FromForwardedIdentityResource): Promise<ResourceInstance> {
  const header = resource.header.toLowerCase();
  return {
    async invoke(inputs: Record<string, any>) {
      const subject = singleValue((inputs as CredentialRequest).headers[header], `The ${resource.header} header`);
      return subject === undefined ? null : { type: "asserted", subject, claims: {} };
    },
    snapshot() {
      return { header: resource.header, schemes: [resource.scheme], requiresTrustedProxy: true };
    },
  };
}

import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { singleValue, type CredentialRequest } from "./credential-source.js";

interface FromHeaderResource extends ResourceManifest {
  header: string;
  scheme: string;
}

export function register(): void {}

export async function create(resource: FromHeaderResource): Promise<ResourceInstance> {
  const header = resource.header.toLowerCase();
  return {
    async invoke(inputs: Record<string, any>) {
      const token = singleValue((inputs as CredentialRequest).headers[header], `The ${resource.header} header`);
      return token === undefined ? null : { type: "token", token };
    },
    snapshot() {
      return { header: resource.header, schemes: [resource.scheme] };
    },
  };
}

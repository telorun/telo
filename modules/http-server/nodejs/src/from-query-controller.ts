import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { singleValue, type CredentialRequest } from "./credential-source.js";

interface FromQueryResource extends ResourceManifest {
  parameter: string;
  scheme: string;
}

export function register(): void {}

export async function create(resource: FromQueryResource): Promise<ResourceInstance> {
  return {
    async invoke(inputs: Record<string, any>) {
      const token = singleValue(
        (inputs as CredentialRequest).query[resource.parameter],
        `The query parameter '${resource.parameter}'`,
      );
      return token === undefined ? null : { type: "token", token };
    },
    snapshot() {
      return {
        parameter: resource.parameter,
        schemes: [resource.scheme],
        ...(resource.scheme.toLowerCase() === "bearer" ? { bearerMethod: "query" } : {}),
      };
    },
  };
}

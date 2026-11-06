import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";

interface VerifierResource extends ResourceManifest {
  issuer: unknown;
}

export function register(): void {}

export async function create(resource: VerifierResource): Promise<ResourceInstance> {
  return {
    async invoke() {
      return { refused: true, reason: "this fixture accepts nothing", challenge: null };
    },
    snapshot() {
      return { issuer: resource.issuer, challenges: [] };
    },
  };
}

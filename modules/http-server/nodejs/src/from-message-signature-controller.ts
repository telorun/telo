import { readMessageSignature, requiredComponentId } from "@telorun/http-signature";
import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import type { CredentialRequest } from "./credential-source.js";
import { configurationRefused, presentationOf, requestDescription } from "./signature-source.js";

interface FromMessageSignatureResource extends ResourceManifest {
  label?: string;
  components: string[];
  scheme: string;
}

export function register(): void {}

export async function create(resource: FromMessageSignatureResource): Promise<ResourceInstance> {
  const label = `Http.FromMessageSignature[${resource.metadata.name}]`;
  const components = [...resource.components];
  const ids: string[] = [];
  components.forEach((component, index) =>
    configurationRefused(label, `components[${index}]`, () => ids.push(requiredComponentId(component))),
  );
  const readsBody = ids.includes('"content-digest"');
  const options = { ...(resource.label === undefined ? {} : { label: resource.label }), components, verifyContentDigest: readsBody };
  return {
    async invoke(inputs: Record<string, any>) {
      return presentationOf(readMessageSignature(requestDescription(inputs as CredentialRequest), options));
    },
    snapshot() {
      return { schemes: [resource.scheme], ...(readsBody ? { readsBody: true } : {}) };
    },
  };
}

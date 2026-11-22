import { compilePattern, readBodySignature, type BodySignatureOptions } from "@telorun/http-signature";
import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import type { CredentialRequest } from "./credential-source.js";
import { configurationRefused, presentationOf, requestDescription } from "./signature-source.js";

type FromBodySignatureResource = ResourceManifest & BodySignatureOptions & { scheme: string };

export function register(): void {}

export async function create(resource: FromBodySignatureResource): Promise<ResourceInstance> {
  const label = `Http.FromBodySignature[${resource.metadata.name}]`;
  const options: BodySignatureOptions = {
    signature: { ...resource.signature },
    ...(resource.timestamp === undefined ? {} : { timestamp: { ...resource.timestamp } }),
    base: resource.base.map((part) => ({ ...part })),
  };
  const patterns: Array<[string, string | undefined]> = [
    ["signature.pattern", options.signature.pattern],
    ["timestamp.pattern", options.timestamp?.pattern],
    ...options.base.map((part, index): [string, string | undefined] => [
      `base[${index}].pattern`,
      part.type === "header" ? part.pattern : undefined,
    ]),
  ];
  for (const [field, pattern] of patterns) {
    if (pattern !== undefined) configurationRefused(label, field, () => compilePattern(pattern));
  }
  return {
    async invoke(inputs: Record<string, any>) {
      return presentationOf(readBodySignature(requestDescription(inputs as CredentialRequest), options));
    },
    snapshot() {
      return { schemes: [resource.scheme], readsBody: true };
    },
  };
}

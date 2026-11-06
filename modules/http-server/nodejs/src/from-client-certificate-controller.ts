import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";
import type { CredentialRequest } from "./credential-source.js";

interface FromClientCertificateResource extends ResourceManifest {
  scheme: string;
}

export function register(): void {}

export async function create(resource: FromClientCertificateResource): Promise<ResourceInstance> {
  return {
    async invoke(inputs: Record<string, any>) {
      const certificate = (inputs as CredentialRequest).clientCertificate;
      if (!certificate) return null;
      const { subject, issuer, serialNumber, fingerprint256, validFrom, validTo, subjectAltNames, pem, verified, via } =
        certificate;
      return {
        type: "certificate",
        subject,
        issuer,
        serialNumber,
        fingerprint256,
        validFrom,
        validTo,
        subjectAltNames,
        pem,
        verified,
        via,
      };
    },
    snapshot() {
      return { schemes: [resource.scheme] };
    },
  };
}

import type { RequestDescription, SignatureReading } from "@telorun/http-signature";
import { RuntimeError } from "@telorun/sdk";
import { credentialMalformed, type CredentialRequest } from "./credential-source.js";

/** The request as the signature grammar reads it. */
export function requestDescription(request: CredentialRequest): RequestDescription {
  return {
    method: request.method,
    targetUri: request.targetUri,
    headers: request.headers as RequestDescription["headers"],
    body: request.body ?? null,
  };
}

/** A reading as a source answers it: null for no credential, a throw for a malformed one. */
export function presentationOf(reading: SignatureReading) {
  if (reading.status === "absent") return null;
  if (reading.status === "malformed") throw credentialMalformed(reading.reason);
  return reading.presentation;
}

/** A configuration value the kind's schema should have refused, refused at creation. */
export function configurationRefused(label: string, field: string, check: () => unknown): void {
  try {
    check();
  } catch (error) {
    throw new RuntimeError(
      "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
      `${label}: '${field}' is invalid: ${(error as Error).message}`,
    );
  }
}

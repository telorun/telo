import { InvokeError } from "@telorun/sdk";

/** What a credential hands back to be merged into the outgoing request. */
export interface CredentialOutputs {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** Every static credential takes its material from config and nothing from the
 *  request, so the one thing that can go wrong is the material being absent —
 *  a variable that resolved to `""`, most often. Refusing here reports it at
 *  the credential; sending it would report it as the server's 401, one
 *  indirection away from the manifest line that has to change. */
export function requireCredentialMaterial(
  value: unknown,
  kind: string,
  name: string,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvokeError(
      "ERR_INVALID_CREDENTIAL",
      `${kind} "${name}": '${field}' must be a non-empty string.`,
    );
  }
  return value;
}

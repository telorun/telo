import { InvokeError } from "@telorun/sdk";

/** What a credential source reads: the request before its body (`Http.CredentialRequest`). */
export interface CredentialRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  /** Values by lower-case header name, a repeated header as a list. */
  readonly headers: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly cookies: Readonly<Record<string, string>>;
  readonly ip: string;
  readonly tls: { readonly protocol: string } | null;
  readonly clientCertificate: Readonly<Record<string, unknown>> | null;
}

export const ERR_HTTP_CREDENTIAL_MALFORMED = "ERR_HTTP_CREDENTIAL_MALFORMED";

/** The request carries the credential, but it cannot be read. */
export function credentialMalformed(message: string): InvokeError {
  return new InvokeError(ERR_HTTP_CREDENTIAL_MALFORMED, message);
}

/**
 * One value read from a header or a query parameter: undefined when absent, the
 * text when given once, malformed when empty or repeated.
 */
export function singleValue(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    throw credentialMalformed(`${where} is given more than once`);
  }
  if (typeof value !== "string") throw credentialMalformed(`${where} is not text`);
  if (value === "") throw credentialMalformed(`${where} is empty`);
  return value;
}

/**
 * The `Authorization` header split as `<scheme> <credentials>`: undefined when
 * absent, the scheme as sent and what follows it otherwise.
 */
export function authorizationHeader(request: CredentialRequest): { scheme: string; rest: string } | undefined {
  const value = singleValue(request.headers.authorization, "The Authorization header");
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  return space < 0
    ? { scheme: trimmed, rest: "" }
    : { scheme: trimmed.slice(0, space), rest: trimmed.slice(space).trim() };
}

/** RFC 9110 `token68`. */
export const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

import type { ClientCertificate } from "@telorun/http-dispatch";
import { celTimestampFromMillis, isCelTimestamp, type CelTimestamp } from "@telorun/sdk";
import { X509Certificate } from "node:crypto";

export type ForwardedCertificateFormat = "xfcc" | "pem" | "base64-der";

/** `Http.Server.forwardedClientCertificate`. */
export interface ForwardedClientCertificate {
  header: string;
  format: ForwardedCertificateFormat;
}

/** A forwarded header read: its certificate, or why it holds none. */
export type ForwardedRead = { certificate: X509Certificate } | { unreadable: string };

/** The record `request.clientCertificate` holds for `x509`. */
export function certificateRecord(
  x509: X509Certificate,
  verified: boolean,
  via: ClientCertificate["via"],
): ClientCertificate {
  const legacy = x509.toLegacyObject();
  return {
    subject: distinguishedName(legacy.subject as unknown as DistinguishedName),
    issuer: distinguishedName(legacy.issuer as unknown as DistinguishedName),
    serialNumber: x509.serialNumber,
    fingerprint256: x509.fingerprint256,
    validFrom: certificateTime(x509.validFrom),
    validTo: certificateTime(x509.validTo),
    subjectAltNames: alternativeNames(x509.subjectAltName),
    pem: x509.toString(),
    verified,
    via,
  };
}

/** The certificate a fronting proxy forwarded in `value`, read as `format`. */
export function readForwardedCertificate(
  value: string,
  format: ForwardedCertificateFormat,
): ForwardedRead {
  switch (format) {
    case "pem": {
      const pem = percentDecoded(value);
      return pem === undefined ? { unreadable: "not URL-escaped text" } : fromPem(pem);
    }
    case "base64-der": {
      const decoded = percentDecoded(value);
      if (decoded === undefined) return { unreadable: "not URL-escaped text" };
      // Traefik lists the chain comma-separated, the client's own certificate first.
      const leaf = decoded.split(",")[0]!.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(leaf)) return { unreadable: "not base64" };
      return fromDer(Buffer.from(leaf, "base64"));
    }
    case "xfcc":
      return fromXfcc(value);
  }
}

/** Envoy's `x-forwarded-client-cert`: one element per proxy, the last written by
 *  the proxy in front of this server; its `Cert` key holds the URL-escaped PEM. */
function fromXfcc(value: string): ForwardedRead {
  const elements = splitOutsideQuotes(value, ",");
  const element = elements[elements.length - 1]!;
  for (const pair of splitOutsideQuotes(element, ";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim().toLowerCase() !== "cert") continue;
    const pem = percentDecoded(unquoted(pair.slice(separator + 1).trim()));
    return pem === undefined ? { unreadable: "a Cert value that is not URL-escaped text" } : fromPem(pem);
  }
  return { unreadable: "no Cert key in the last element" };
}

function fromPem(pem: string): ForwardedRead {
  if (!pem.trimStart().startsWith("-----BEGIN CERTIFICATE-----")) {
    return { unreadable: "not a PEM certificate" };
  }
  try {
    return { certificate: new X509Certificate(pem) };
  } catch (err) {
    return { unreadable: `not a valid certificate: ${(err as Error).message}` };
  }
}

function fromDer(der: Buffer): ForwardedRead {
  try {
    return { certificate: new X509Certificate(der) };
  } catch (err) {
    return { unreadable: `not a valid certificate: ${(err as Error).message}` };
  }
}

function percentDecoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** A value wrapped in double quotes, its backslash escapes resolved. */
function unquoted(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  return text.slice(1, -1).replace(/\\(.)/g, "$1");
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted && char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Each attribute's value, an array when the attribute repeats. */
type DistinguishedName = Record<string, string | string[] | undefined> | undefined;

function distinguishedName(names: DistinguishedName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [attribute, value] of Object.entries(names ?? {})) {
    if (value === undefined) continue;
    out[attribute] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Node's `DNS:a, IP Address:b` text as entries; a value holding a separator is
 *  quoted as a JSON string there. */
function alternativeNames(text: string | undefined): string[] {
  if (!text) return [];
  return splitOutsideQuotes(text, ",").map((entry) => {
    const trimmed = entry.trim();
    const colon = trimmed.indexOf(":");
    const value = trimmed.slice(colon + 1);
    return value.startsWith('"') ? `${trimmed.slice(0, colon + 1)}${JSON.parse(value)}` : trimmed;
  });
}

function certificateTime(text: string): CelTimestamp {
  const value = celTimestampFromMillis(Date.parse(text));
  if (!isCelTimestamp(value)) throw new Error(`Unreadable certificate validity time '${text}'`);
  return value;
}

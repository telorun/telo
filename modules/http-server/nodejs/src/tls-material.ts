import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** One PEM item: its text inline, or a file on the host. */
export type PemSource = { pem?: string; file?: string };

export interface ServerTlsSettings {
  cert: PemSource;
  key: PemSource;
  passphrase?: string;
  clientCa?: PemSource[];
  clientCertificate?: "none" | "required";
}

export interface HttpsOptions {
  cert: string;
  key: string;
  passphrase?: string;
  ca?: string[];
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}

export const ERR_HTTP_TLS_INVALID = "ERR_HTTP_TLS_INVALID";

export class TlsMaterialError extends Error {
  readonly code = ERR_HTTP_TLS_INVALID;
}

function read(source: PemSource, what: string): string {
  const hasPem = typeof source?.pem === "string";
  const hasFile = typeof source?.file === "string";
  if (hasPem === hasFile) {
    throw new TlsMaterialError(`Http.Server tls.${what}: set exactly one of 'pem' or 'file'.`);
  }
  if (hasPem) return source.pem as string;
  try {
    return readFileSync(source.file as string, "utf8");
  } catch (err) {
    throw new TlsMaterialError(
      `Http.Server tls.${what}: cannot read '${source.file}': ${(err as Error).message}`,
    );
  }
}

function certificatesOf(pem: string, what: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) throw new TlsMaterialError(`Http.Server tls.${what}: no PEM certificate found.`);
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new TlsMaterialError(`Http.Server tls.${what}: a certificate is not valid PEM.`);
    }
  }
  return blocks;
}

/** Reads, parses and cross-checks the settings. No message carries key text. */
export function resolveHttpsOptions(tls: ServerTlsSettings): HttpsOptions {
  const certPem = read(tls.cert, "cert");
  const certs = certificatesOf(certPem, "cert");
  const keyPem = read(tls.key, "key");
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: keyPem, passphrase: tls.passphrase });
  } catch {
    throw new TlsMaterialError(
      "Http.Server tls.key: not a valid PEM private key (or the passphrase is wrong).",
    );
  }
  if (!new X509Certificate(certs[0]).checkPrivateKey(privateKey)) {
    throw new TlsMaterialError("Http.Server tls: 'key' does not match 'cert'.");
  }
  const options: HttpsOptions = { cert: certPem, key: keyPem };
  if (tls.passphrase !== undefined) options.passphrase = tls.passphrase;

  const mode = tls.clientCertificate ?? "none";
  if (mode !== "none") {
    if (!tls.clientCa || tls.clientCa.length === 0) {
      throw new TlsMaterialError(
        "Http.Server tls: 'clientCertificate' needs 'clientCa' to verify the certificates against.",
      );
    }
    options.ca = tls.clientCa.flatMap((source, i) =>
      certificatesOf(read(source, `clientCa[${i}]`), `clientCa[${i}]`),
    );
    options.requestCert = true;
    options.rejectUnauthorized = true;
  } else if (tls.clientCa && tls.clientCa.length > 0) {
    throw new TlsMaterialError("Http.Server tls: 'clientCa' is set but 'clientCertificate' is 'none'.");
  }
  return options;
}

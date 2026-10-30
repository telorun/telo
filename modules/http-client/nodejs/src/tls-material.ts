import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";

/** One PEM item: its text inline, or a file on the host. */
export type PemSource = { pem?: string; file?: string };

export interface TlsSettings {
  ca?: PemSource[];
  caMode?: "replace" | "add";
  cert?: PemSource;
  key?: PemSource;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
}

/** What undici's `connect` takes. */
export interface ConnectOptions {
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
  servername?: string;
  rejectUnauthorized?: boolean;
}

export const ERR_HTTP_TLS_INVALID = "ERR_HTTP_TLS_INVALID";

export class TlsMaterialError extends Error {
  readonly code = ERR_HTTP_TLS_INVALID;
  constructor(message: string) {
    super(message);
  }
}

function read(source: PemSource, what: string): string {
  const hasPem = typeof source?.pem === "string";
  const hasFile = typeof source?.file === "string";
  if (hasPem === hasFile) {
    throw new TlsMaterialError(`Http.Client tls.${what}: set exactly one of 'pem' or 'file'.`);
  }
  if (hasPem) return source.pem as string;
  try {
    return readFileSync(source.file as string, "utf8");
  } catch (err) {
    throw new TlsMaterialError(
      `Http.Client tls.${what}: cannot read '${source.file}': ${(err as Error).message}`,
    );
  }
}

// A PEM bundle may hold several certificates; each is parsed so a garbled one is
// refused here instead of surfacing as an opaque handshake failure later.
function certificatesOf(pem: string, what: string): string[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) throw new TlsMaterialError(`Http.Client tls.${what}: no PEM certificate found.`);
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new TlsMaterialError(`Http.Client tls.${what}: a certificate is not valid PEM.`);
    }
  }
  return blocks;
}

/** Reads, parses and cross-checks the settings. No message carries key text. */
export function resolveConnectOptions(tls: TlsSettings): ConnectOptions {
  const options: ConnectOptions = {};

  if (tls.ca && tls.ca.length > 0) {
    const ca = tls.ca.flatMap((source, index) => certificatesOf(read(source, `ca[${index}]`), `ca[${index}]`));
    options.ca = tls.caMode === "add" ? [...rootCertificates, ...ca] : ca;
  }

  if ((tls.cert === undefined) !== (tls.key === undefined)) {
    throw new TlsMaterialError("Http.Client tls: 'cert' and 'key' must be set together.");
  }
  if (tls.cert && tls.key) {
    const certPem = read(tls.cert, "cert");
    const certs = certificatesOf(certPem, "cert");
    const keyPem = read(tls.key, "key");
    let privateKey;
    try {
      privateKey = createPrivateKey({ key: keyPem, passphrase: tls.passphrase });
    } catch {
      throw new TlsMaterialError(
        "Http.Client tls.key: not a valid PEM private key (or the passphrase is wrong).",
      );
    }
    if (!new X509Certificate(certs[0]).checkPrivateKey(privateKey)) {
      throw new TlsMaterialError("Http.Client tls: 'key' does not match 'cert'.");
    }
    options.cert = certPem;
    options.key = keyPem;
    if (tls.passphrase !== undefined) options.passphrase = tls.passphrase;
  }

  if (tls.serverName) options.servername = tls.serverName;
  if (tls.insecureSkipVerify) options.rejectUnauthorized = false;
  return options;
}

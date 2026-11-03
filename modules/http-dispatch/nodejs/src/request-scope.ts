import type { CelTimestamp, InvokeContext } from "@telorun/sdk";

/** The TLS session of the socket a request arrived on. */
export interface RequestTls {
  /** The negotiated protocol version, e.g. `TLSv1.3`. */
  readonly protocol: string;
}

/**
 * The certificate a client presented, whether to this listener or to a fronting
 * proxy that forwarded it. `subject` and `issuer` map each attribute (`CN`, `O`,
 * …) to its value, a repeated attribute's values joined with `, `.
 */
export interface ClientCertificate {
  readonly subject: Readonly<Record<string, string>>;
  readonly issuer: Readonly<Record<string, string>>;
  /** Uppercase hexadecimal. */
  readonly serialNumber: string;
  /** SHA-256 of the DER bytes, colon-separated uppercase hexadecimal. */
  readonly fingerprint256: string;
  readonly validFrom: CelTimestamp;
  readonly validTo: CelTimestamp;
  /** Each entry `<type>:<value>`, e.g. `DNS:example.test`, `IP Address:127.0.0.1`. */
  readonly subjectAltNames: readonly string[];
  readonly pem: string;
  /** True only when the listener validated the chain against its client CAs. */
  readonly verified: boolean;
  readonly via: "listener" | "proxy";
}

/**
 * What an HTTP transport hands every mount it registers, as the third argument of
 * `register(app, prefix, requestScope)`: the transport opens one span per request
 * before anything runs for it, and a mount dispatches the request's work on it.
 *
 * `TRequest` is the transport's own request object (a Fastify request for
 * `Http.Server`), so the scope is looked up by the value the mount already holds.
 */
export interface RequestScope<TRequest> {
  /** The scope of a request the transport is serving. Throws for a request the
   *  transport did not open, which is a transport defect rather than a miss. */
  forRequest(request: TRequest): RequestTrace;
}

/** One request's unit of work. */
export interface RequestTrace {
  /** The request span's context, carrying the request's cancellation (a client
   *  disconnect cancels it). Every dispatch the request drives runs on it. */
  readonly context: InvokeContext;
  /** The language negotiated for the request, always a served tag. Reading it
   *  records that the response depends on the language, which is what makes the
   *  transport send `Content-Language` and `Vary`: read it only to use it. */
  readonly lang: string;
  /** The TLS session of this request's socket; null on a plain socket. */
  readonly tls: RequestTls | null;
  /** The client certificate the listener received or a trusted proxy forwarded;
   *  null when there is none. */
  readonly clientCertificate: ClientCertificate | null;
  /** Report the error that decided the response, when the mount renders it
   *  itself (a `catches:` rung, a request-validation refusal). An error the mount
   *  rethrows reaches the transport, which reports it. */
  reject(error: unknown): void;
}

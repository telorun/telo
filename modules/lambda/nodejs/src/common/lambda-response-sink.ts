import type { ResponseSink } from "@telorun/http-dispatch";

/**
 * Buffered `ResponseSink` adapter that produces an AWS API Gateway HTTP API v2
 * response envelope: `{ statusCode, headers, body, isBase64Encoded }`.
 *
 * Unlike `fastifyReplySink`, which flushes to the wire, the Lambda runtime
 * needs the entire response materialised as a JSON-serialisable object so the
 * Function controller can return it as the AWS invocation result. Hence
 * `send()` stores the body rather than committing it; `getResponse()` produces
 * the envelope after `dispatchReturns` / `dispatchCatches` returns.
 *
 * Streaming (`mode: stream` in the returns: contract) is **not** supported in
 * v1 — AWS streaming requires either the managed-runtime `awslambda.streamifyResponse`
 * wrapper or custom-runtime chunked POSTs against the Runtime API. Tracked as
 * a follow-up; for now, `stream()` throws so the failure surfaces with a clear
 * diagnostic rather than silently returning the wrong shape.
 */
export interface LambdaApiV2Response {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export class LambdaResponseSink implements ResponseSink {
  private status = 200;
  private readonly headers: Record<string, string> = {};
  private body: string | undefined;
  private base64 = false;
  private sent = false;

  setStatus(code: number): void {
    this.ensureOpen("setStatus");
    this.status = code;
  }

  setHeader(name: string, value: string): void {
    this.ensureOpen("setHeader");
    this.headers[name.toLowerCase()] = value;
  }

  async send(body?: unknown): Promise<void> {
    this.ensureOpen("send");
    this.sent = true;
    if (body === undefined) return;

    if (typeof body === "string") {
      this.body = body;
      return;
    }
    if (body instanceof Uint8Array) {
      this.body = Buffer.from(body).toString("base64");
      this.base64 = true;
      return;
    }
    // Object / array / number / boolean / null — serialise as JSON. The
    // dispatcher already negotiated the Content-Type; we just produce a string
    // body. Last-write-wins setHeader has the final Content-Type accumulated.
    this.body = JSON.stringify(body);
  }

  async stream(
    iter: AsyncIterable<Uint8Array>,
    onError?: (err: unknown) => void | Promise<void>,
  ): Promise<void> {
    void iter;
    void onError;
    throw new Error(
      "Lambda.HttpApi: response streaming is not supported in v1. " +
        "Use buffer mode (omit `mode: stream` from returns: entries).",
    );
  }

  getResponse(): LambdaApiV2Response {
    const response: LambdaApiV2Response = {
      statusCode: this.status,
      headers: this.headers,
    };
    if (this.body !== undefined) {
      response.body = this.body;
      if (this.base64) response.isBase64Encoded = true;
    }
    return response;
  }

  private ensureOpen(method: string): void {
    if (this.sent) {
      throw new Error(`LambdaResponseSink: ${method} called after response was sent`);
    }
  }
}

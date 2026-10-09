/** One call to the Telo Cloud API. `path` is a path under the API base
 *  (`/session`, `/v1/projects`) — never a URL: where the API lives is the
 *  transport's, and on the desktop the shell refuses anything else. */
export interface CloudRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Every body the API takes is JSON text. */
  body?: string;
}

/**
 * How Studio reaches Telo Cloud. Two implementations, chosen by build target
 * (`backend.ts`), and nothing else knows which is active: the web build asks
 * its own origin with the session cookie, the desktop build hands the request
 * to the shell, which holds the tokens. Neither gives JavaScript a credential.
 */
export interface CloudTransport {
  request(request: CloudRequest): Promise<Response>;
}

/** The request never produced an HTTP answer. */
export class CloudUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudUnreachableError";
  }
}

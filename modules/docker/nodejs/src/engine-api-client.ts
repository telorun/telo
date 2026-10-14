import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

/** The Engine API version every request names. */
export const API_VERSION = "v1.41";

/** Where requests go: a unix socket, or a host over HTTP(S) with an optional
 *  path prefix. Parsed once from the resource's `endpoint`. */
export interface EngineTarget {
  readonly endpoint: string;
  readonly secure: boolean;
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly prefix: string;
}

export function parseEndpoint(endpoint: string): EngineTarget {
  if (endpoint.startsWith("unix://")) {
    return { endpoint, secure: false, socketPath: endpoint.slice("unix://".length), prefix: "" };
  }
  const url = new URL(endpoint.startsWith("tcp://") ? `http://${endpoint.slice(6)}` : endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`'${endpoint}' is not a unix://, tcp://, http:// or https:// endpoint`);
  }
  const secure = url.protocol === "https:";
  return {
    endpoint,
    secure,
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    prefix: url.pathname.replace(/\/+$/, ""),
  };
}

export interface EngineRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** A response the engine answered with a status outside 2xx. */
export class EngineStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EngineStatusError";
  }
}

/**
 * One HTTP exchange with the engine. Resolves with the response once its
 * headers arrive and its status is 2xx; a non-2xx answer is read whole and
 * rejected as an {@link EngineStatusError} carrying the engine's message.
 */
export function send(
  target: EngineTarget,
  token: string | undefined,
  req: EngineRequest,
): Promise<IncomingMessage> {
  const query = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body));
  const headers: Record<string, string> = { host: target.host ?? "docker" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const options: RequestOptions = {
    method: req.method,
    path: `${target.prefix}/${API_VERSION}${req.path}${query}`,
    headers,
    signal: req.signal,
    ...(target.socketPath
      ? { socketPath: target.socketPath }
      : { host: target.host, port: target.port }),
  };
  return new Promise((resolve, reject) => {
    const outgoing = (target.secure ? httpsRequest : httpRequest)(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) {
        resolve(res);
        return;
      }
      readText(res).then(
        (text) => reject(new EngineStatusError(status, `${req.method} ${req.path} answered ${status}: ${engineMessage(text)}`)),
        reject,
      );
    });
    outgoing.on("error", (err) =>
      reject(
        req.signal?.aborted
          ? err
          : new Error(`cannot reach the engine at ${target.endpoint}: ${err.message}`),
      ),
    );
    outgoing.end(body);
  });
}

export async function readText(res: IncomingMessage): Promise<string> {
  let text = "";
  res.setEncoding("utf8");
  for await (const chunk of res) text += chunk;
  return text;
}

export async function readJson(res: IncomingMessage): Promise<unknown> {
  const text = await readText(res);
  return text === "" ? undefined : JSON.parse(text);
}

/** The engine's own wording: `{"message": …}` when it sent one. */
function engineMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // Not JSON: the body is the message.
  }
  return text.trim() || "(no message)";
}

import type { RecordsPage } from "./records";
import type { AgentIdentityState, TreeFile } from "./types";

export type { TreeFile };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch that rides out a proxy warm-up: a fronting proxy (Caddy) returns 503
 * until it has detected the freshly-launched per-session upstream, and a network
 * error means it isn't reachable yet. Retries a few times with a capped backoff
 * (~10s total), then surfaces the last result. Every attempt sends the same
 * `init`, so a POST /chat whose first attempt did land is recognised by its
 * `Idempotency-Key` rather than starting a second turn.
 */
async function fetchRetrying(url: string, init?: RequestInit, retries = 6): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 503 && attempt < retries) {
        await delay(Math.min(400 * (attempt + 1), 2500));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await delay(Math.min(400 * (attempt + 1), 2500));
    }
  }
}

export interface StartTurnResult {
  kind: "started";
  turnId: string;
}
/** A non-200 answer, by the `code` its body carries (`ERR_AT_CAPACITY`,
 *  `ERR_RATE_LIMITED`, `ERR_TURN_IN_PROGRESS`, `ERR_TURN_NOT_CONTINUABLE`,
 *  `ERR_IDEMPOTENCY_KEY_REUSED`, …), with the fields a code carries. */
export interface TurnRefused {
  kind: "refused";
  status: number;
  code: string | undefined;
  message: string;
  retryAfter?: number;
  /** `ERR_TURN_IN_PROGRESS`: the turn that is running. */
  activeTurnId?: string;
  /** `ERR_TURN_NOT_CONTINUABLE`: `finished`, `aborted` or `superseded`. */
  reason?: string;
}
export type StartTurnOutcome = StartTurnResult | TurnRefused;

export interface ContinueTurnResult {
  kind: "continued";
  turnId: string;
  /** The last record before the new attempt; its `turn-continued` record is next. */
  fromId: number;
}
export type ContinueTurnOutcome = ContinueTurnResult | TurnRefused;

async function readBody(res: Response, what: string): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${what} returned an unreadable body (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The code an agent refuses a request without its bearer token with. */
export const ERR_UNAUTHENTICATED = "ERR_UNAUTHENTICATED";
/** What the user reads for it, wherever it surfaces. */
export const TOKEN_REQUIRED_MESSAGE = "This agent requires a token.";

function refusal(res: Response, body: Record<string, unknown>, what: string): TurnRefused {
  return {
    kind: "refused",
    status: res.status,
    code: typeof body.code === "string" ? body.code : undefined,
    message:
      body.code === ERR_UNAUTHENTICATED
        ? TOKEN_REQUIRED_MESSAGE
        : typeof body.error === "string"
          ? body.error
          : `${what} failed (${res.status})`,
    retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
    activeTurnId: typeof body.activeTurnId === "string" ? body.activeTurnId : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}

/** The agent is still admitting an earlier attempt carrying the same key. */
const ERR_IDEMPOTENCY_KEY_IN_FLIGHT = "ERR_IDEMPOTENCY_KEY_IN_FLIGHT";
const IN_FLIGHT_RETRIES = 10;

/** A request the agent refused for want of a token, or a request that failed
 *  otherwise — named by route and status either way. */
function failure(res: Response, what: string): Error {
  return new Error(res.status === 401 ? TOKEN_REQUIRED_MESSAGE : `${what} failed (${res.status})`);
}

/** The `Authorization` header a token requires, merged into `headers`. Nothing
 *  is added without one, so an open agent sees exactly the requests it did. */
export function withToken(token: string | undefined, headers?: Record<string, string>): Record<string, string> | undefined {
  if (!token) return headers;
  return { ...headers, authorization: `Bearer ${token}` };
}

/** Thin client for the authoring-agent's HTTP contract. `baseUrl` is the running
 *  agent service; `token`, when known, rides every request as a bearer token —
 *  the runner-minted one from the agent's endpoint, or the one a user entered. */
export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private init(init: RequestInit = {}): RequestInit | undefined {
    const headers = withToken(this.token, init.headers as Record<string, string> | undefined);
    const merged = headers ? { ...init, headers } : init;
    return Object.keys(merged).length === 0 ? undefined : merged;
  }

  /** GET /capabilities → who the agent is. Fetched once per agent instance by
   *  the caller. An agent without the route (404) has no identity to show. */
  async capabilities(): Promise<AgentIdentityState> {
    const res = await fetchRetrying(this.url("/capabilities"), this.init());
    if (res.status === 404) return { state: "unavailable" };
    if (res.status === 401) return { state: "unauthorized" };
    if (!res.ok) throw failure(res, "GET /capabilities");
    const body = await readBody(res, "GET /capabilities");
    const agent = (body.agent ?? {}) as Record<string, unknown>;
    const prompt = (body.prompt ?? {}) as Record<string, unknown>;
    return {
      state: "known",
      identity: {
        name: String(agent.name ?? ""),
        version: String(agent.version ?? ""),
        promptId: String(prompt.id ?? ""),
        auth: typeof body.auth === "string" ? body.auth : "",
      },
    };
  }

  /**
   * POST /chat → 200 { turnId }, or a coded refusal.
   *
   * One call is one send ATTEMPT, and it mints one `Idempotency-Key` that every
   * retry inside it repeats — a proxy 503, a network error, and an
   * `ERR_IDEMPOTENCY_KEY_IN_FLIGHT` answer (the agent is still admitting an
   * earlier copy of this very request). A resend after a failed turn is a new
   * call, so a new attempt with a key of its own.
   */
  async startTurn(conversationId: string, message: string): Promise<StartTurnOutcome> {
    const init = this.init({
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ conversationId, message }),
    });
    for (let attempt = 0; ; attempt++) {
      const res = await fetchRetrying(this.url("/chat"), init);
      const body = await readBody(res, "POST /chat");
      if (res.status === 200) {
        if (typeof body.turnId !== "string" && typeof body.turnId !== "number") {
          throw new Error("POST /chat succeeded but returned no turnId.");
        }
        return { kind: "started", turnId: String(body.turnId) };
      }
      if (body.code === ERR_IDEMPOTENCY_KEY_IN_FLIGHT && attempt < IN_FLIGHT_RETRIES) {
        await delay(Math.min(200 * (attempt + 1), 1000));
        continue;
      }
      return refusal(res, body, "POST /chat");
    }
  }

  /** POST /chat/{turnId}/abort, no body → whether a running attempt was
   *  cancelled. `cancelled: false` means nothing was running for the turn. Any
   *  other answer (404 unknown, 410 removed, …) throws with its code. */
  async abortTurn(turnId: string): Promise<{ cancelled: boolean }> {
    const what = `POST /chat/${turnId}/abort`;
    const res = await fetchRetrying(this.url(`/chat/${encodeURIComponent(turnId)}/abort`), this.init({ method: "POST" }));
    const body = await readBody(res, what);
    if (!res.ok) {
      const refused = refusal(res, body, what);
      throw new Error(`${refused.message}${refused.code ? ` (${refused.code})` : ""}`);
    }
    return { cancelled: body.cancelled === true };
  }

  /** POST /chat/{turnId}/continue, no body → another attempt at an interrupted
   *  turn, inside the same turn, or a coded refusal. */
  async continueTurn(turnId: string): Promise<ContinueTurnOutcome> {
    const what = `POST /chat/${turnId}/continue`;
    const res = await fetchRetrying(this.url(`/chat/${encodeURIComponent(turnId)}/continue`), this.init({ method: "POST" }));
    const body = await readBody(res, what);
    if (res.status !== 200) return refusal(res, body, what);
    if (typeof body.fromId !== "number") throw new Error(`${what} succeeded but returned no fromId.`);
    return { kind: "continued", turnId: String(body.turnId ?? turnId), fromId: body.fromId };
  }

  /** GET /workspace → the agent's content-hash tree. */
  async workspaceTree(): Promise<TreeFile[]> {
    const res = await fetchRetrying(this.url("/workspace"), this.init());
    if (!res.ok) throw failure(res, "GET /workspace");
    const body = await res.json();
    return Array.isArray(body.files) ? body.files : [];
  }

  /** POST /workspace — apply an explicit write/delete change set (Fs.TreeSync). */
  async syncWorkspace(write: Array<{ path: string; content: string }>, del: string[]): Promise<void> {
    const res = await fetchRetrying(
      this.url("/workspace"),
      this.init({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ write, delete: del }),
      }),
    );
    if (!res.ok) throw failure(res, "POST /workspace");
  }

  /** GET /workspace/file?path= → one file's contents. */
  async readWorkspaceFile(path: string): Promise<string> {
    const res = await fetchRetrying(this.url(`/workspace/file?path=${encodeURIComponent(path)}`), this.init());
    if (!res.ok) throw failure(res, "GET /workspace/file");
    const body = await res.json();
    return typeof body.content === "string" ? body.content : "";
  }

  /** GET /conversations/{id}/records → one page of the conversation's turns and
   *  their records, from `cursor` (the previous page's `next`). */
  async records(
    conversationId: string,
    cursor: { fromTurn: string; fromId: number } | null,
  ): Promise<RecordsPage> {
    const url = new URL(this.url(`/conversations/${encodeURIComponent(conversationId)}/records`), window.location.href);
    if (cursor) {
      url.searchParams.set("fromTurn", cursor.fromTurn);
      url.searchParams.set("fromId", String(cursor.fromId));
    }
    const res = await fetchRetrying(url.toString(), this.init());
    if (!res.ok) throw failure(res, `GET /conversations/${conversationId}/records`);
    const body = (await res.json()) as Partial<RecordsPage>;
    return { turns: Array.isArray(body.turns) ? body.turns : [], next: body.next ?? null };
  }
}

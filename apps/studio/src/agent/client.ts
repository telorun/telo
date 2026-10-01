import type { RecordsPage } from "./records";
import type {
  AgentIdentityState,
  Conversation,
  ConversationPage,
  TreeFile,
  TurnChanges,
  TurnRevert,
} from "./types";

export type { TreeFile };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch that rides out a proxy warm-up: a fronting proxy (Caddy) returns 503
 * until it has detected the freshly-launched per-session upstream, and a network
 * error means it isn't reachable yet. The agent's own 503 `ERR_WORKSPACE_BUSY`
 * — a revert or a pushed change set that found the workspace locked — is
 * resent the same way, which is what that refusal asks for. Retries a few times
 * with a capped backoff (~10s total), then surfaces the last result. Every attempt sends the same
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

/** A conversation request the agent refused, by status and the `code` its body
 *  carries, with the fields a code carries (`revision` on
 *  `ERR_CONVERSATION_CHANGED`, `activeTurnId` on `ERR_TURN_IN_PROGRESS`). The
 *  message ends with the code, so wherever it is shown the code is too. */
export class AgentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly revision?: number,
    readonly activeTurnId?: string,
  ) {
    super(message);
  }
}

export const ERR_CONVERSATION_NOT_FOUND = "ERR_CONVERSATION_NOT_FOUND";
export const ERR_CONVERSATION_REMOVED = "ERR_CONVERSATION_REMOVED";
export const ERR_CONVERSATION_ARCHIVED = "ERR_CONVERSATION_ARCHIVED";
export const ERR_CONVERSATION_CHANGED = "ERR_CONVERSATION_CHANGED";
export const ERR_TURN_IN_PROGRESS = "ERR_TURN_IN_PROGRESS";

/** The error a non-2xx conversation answer is, read from its body when it has one. */
async function requestError(res: Response, what: string): Promise<AgentRequestError> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const code = typeof body.code === "string" ? body.code : undefined;
  const said =
    res.status === 401
      ? TOKEN_REQUIRED_MESSAGE
      : typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : `${what} failed (${res.status})${text && !code ? `: ${text.slice(0, 200)}` : ""}`;
  return new AgentRequestError(
    code ? `${said} (${code})` : said,
    res.status,
    code,
    typeof body.revision === "number" ? body.revision : undefined,
    typeof body.activeTurnId === "string" ? body.activeTurnId : undefined,
  );
}

/** A conversation as the wire carries it, or a named failure when it is not one. */
function readConversationBody(body: unknown, what: string): Conversation {
  const c = (body ?? {}) as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.revision !== "number") {
    throw new Error(`${what} returned no conversation.`);
  }
  return {
    id: c.id,
    title: typeof c.title === "string" ? c.title : null,
    createdAt: String(c.createdAt ?? ""),
    updatedAt: String(c.updatedAt ?? ""),
    model: typeof c.model === "string" ? c.model : null,
    messageCount: typeof c.messageCount === "number" ? c.messageCount : 0,
    totalTokens: typeof c.totalTokens === "number" ? c.totalTokens : 0,
    archived: c.archived === true,
    revision: c.revision,
  };
}

/** A recorded revert as the wire carries it; null when there is none. */
function readRevert(value: unknown): TurnRevert | null {
  const revert = value as { revertedAt?: unknown; files?: unknown } | null | undefined;
  if (!revert || typeof revert !== "object" || !Array.isArray(revert.files)) return null;
  return { revertedAt: String(revert.revertedAt ?? ""), files: revert.files as TurnRevert["files"] };
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
        ...(Array.isArray(body.features)
          ? { features: body.features.filter((f): f is string => typeof f === "string") }
          : {}),
        ...(typeof body.manifestRuns === "boolean" ? { manifestRuns: body.manifestRuns } : {}),
      },
    };
  }

  /** POST /conversations, no body → 201, the new (empty) conversation. */
  async createConversation(): Promise<Conversation> {
    const what = "POST /conversations";
    const res = await fetchRetrying(this.url("/conversations"), this.init({ method: "POST" }));
    if (res.status !== 201) throw await requestError(res, what);
    return readConversationBody(await readBody(res, what), what);
  }

  /** GET /conversations/{id} → 200, or 404 `ERR_CONVERSATION_NOT_FOUND` / 410
   *  `ERR_CONVERSATION_REMOVED` as an `AgentRequestError`. */
  async conversation(id: string): Promise<Conversation> {
    const what = `GET /conversations/${id}`;
    const res = await fetchRetrying(this.url(`/conversations/${encodeURIComponent(id)}`), this.init());
    if (!res.ok) throw await requestError(res, what);
    return readConversationBody(await readBody(res, what), what);
  }

  /** GET /conversations → one page, newest activity first. */
  async listConversations(query: {
    limit?: number;
    archived?: boolean;
    q?: string;
    cursor?: { before: string; beforeId: string } | null;
  }): Promise<ConversationPage> {
    const what = "GET /conversations";
    const url = new URL(this.url("/conversations"), window.location.href);
    if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
    if (query.archived) url.searchParams.set("archived", "true");
    if (query.q) url.searchParams.set("q", query.q);
    if (query.cursor) {
      url.searchParams.set("before", query.cursor.before);
      url.searchParams.set("beforeId", query.cursor.beforeId);
    }
    const res = await fetchRetrying(url.toString(), this.init());
    if (!res.ok) throw await requestError(res, what);
    const body = await readBody(res, what);
    const next = body.next as { before?: unknown; beforeId?: unknown } | null | undefined;
    return {
      conversations: Array.isArray(body.conversations)
        ? body.conversations.map((c) => readConversationBody(c, what))
        : [],
      next:
        next && typeof next.before === "string" && typeof next.beforeId === "string"
          ? { before: next.before, beforeId: next.beforeId }
          : null,
    };
  }

  /** PATCH /conversations/{id} `{ title?, archived? }` → 200, the conversation. */
  async updateConversation(id: string, change: { title?: string; archived?: boolean }): Promise<Conversation> {
    const what = `PATCH /conversations/${id}`;
    const res = await fetchRetrying(
      this.url(`/conversations/${encodeURIComponent(id)}`),
      this.init({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }),
    );
    if (!res.ok) throw await requestError(res, what);
    return readConversationBody(await readBody(res, what), what);
  }

  /** DELETE /conversations/{id} → 204; refused 409 `ERR_TURN_IN_PROGRESS`
   *  (with `activeTurnId`) while its latest turn runs. */
  async deleteConversation(id: string): Promise<void> {
    const res = await fetchRetrying(
      this.url(`/conversations/${encodeURIComponent(id)}`),
      this.init({ method: "DELETE" }),
    );
    if (res.status !== 204) throw await requestError(res, `DELETE /conversations/${id}`);
  }

  /** DELETE /conversations/{id}/turns?from=&revision= → the turn `from` and every
   *  later one removed; refused 409 `ERR_CONVERSATION_CHANGED` (with the current
   *  `revision`) when the conversation moved past `revision`. */
  async truncateConversation(
    id: string,
    fromTurnId: string,
    revision: number,
  ): Promise<{ removedTurns: number; conversation: Conversation }> {
    const what = `DELETE /conversations/${id}/turns`;
    const url = new URL(this.url(`/conversations/${encodeURIComponent(id)}/turns`), window.location.href);
    url.searchParams.set("from", fromTurnId);
    url.searchParams.set("revision", String(revision));
    const res = await fetchRetrying(url.toString(), this.init({ method: "DELETE" }));
    if (!res.ok) throw await requestError(res, what);
    const body = await readBody(res, what);
    return {
      removedTurns: typeof body.removedTurns === "number" ? body.removedTurns : 0,
      conversation: readConversationBody(body.conversation, what),
    };
  }

  /** POST /conversations/{id}/branch `{ throughTurnId }` → 201, the new
   *  conversation holding a copy of every turn through that one. */
  async branchConversation(id: string, throughTurnId: string): Promise<Conversation> {
    const what = `POST /conversations/${id}/branch`;
    const res = await fetchRetrying(
      this.url(`/conversations/${encodeURIComponent(id)}/branch`),
      this.init({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ throughTurnId }),
      }),
    );
    if (res.status !== 201) throw await requestError(res, what);
    return readConversationBody(await readBody(res, what), what);
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

  /** GET /chat/{turnId}/changes → the turn's net changes as diffs, and its
   *  recorded revert. `files: null` for a turn from before checkpoints. Refused
   *  404 `ERR_TURN_NOT_FOUND` / 410 `ERR_JOURNAL_KEY_REMOVED`, or as its
   *  conversation is. */
  async turnChanges(turnId: string): Promise<TurnChanges> {
    const what = `GET /chat/${turnId}/changes`;
    const res = await fetchRetrying(this.url(`/chat/${encodeURIComponent(turnId)}/changes`), this.init());
    if (!res.ok) throw await requestError(res, what);
    const body = await readBody(res, what);
    return {
      files: Array.isArray(body.files) ? (body.files as NonNullable<TurnChanges["files"]>) : null,
      revert: readRevert(body.revert),
    };
  }

  /** POST /chat/{turnId}/revert, no body → what each path's revert did, and the
   *  conversation's revision after it. Refused 409 `ERR_TURN_IN_PROGRESS` /
   *  `ERR_CONVERSATION_ARCHIVED` / `ERR_TURN_NOT_CHECKPOINTED`, 404 / 410 for a
   *  turn or conversation that is gone, and 503 `ERR_WORKSPACE_BUSY` once the
   *  resends are spent. */
  async revertTurn(turnId: string): Promise<{ revert: TurnRevert; revision?: number }> {
    const what = `POST /chat/${turnId}/revert`;
    const res = await fetchRetrying(this.url(`/chat/${encodeURIComponent(turnId)}/revert`), this.init({ method: "POST" }));
    if (!res.ok) throw await requestError(res, what);
    const body = await readBody(res, what);
    const revert = readRevert(body.revert);
    if (!revert) throw new Error(`${what} succeeded but returned no revert.`);
    return { revert, ...(typeof body.revision === "number" ? { revision: body.revision } : {}) };
  }

  /** GET /workspace → the agent's content-hash tree. An answer carrying no
   *  file list is a failed read, never an empty tree: an empty tree is what
   *  licenses deleting the editor's copies of a reverted turn's files. */
  async workspaceTree(): Promise<TreeFile[]> {
    const res = await fetchRetrying(this.url("/workspace"), this.init());
    if (!res.ok) throw failure(res, "GET /workspace");
    const body = await res.json();
    if (!Array.isArray(body?.files)) throw new Error("GET /workspace returned no file list.");
    return body.files;
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
    if (!res.ok) throw await requestError(res, `GET /conversations/${conversationId}/records`);
    const body = (await res.json()) as Partial<RecordsPage>;
    return { turns: Array.isArray(body.turns) ? body.turns : [], next: body.next ?? null };
  }
}

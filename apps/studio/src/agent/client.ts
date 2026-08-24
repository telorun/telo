import type { AgentHistoryRow, AgentStreamPart } from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch that rides out a proxy warm-up: a fronting proxy (Caddy) returns 503
 * until it has detected the freshly-launched per-session upstream, and a network
 * error means it isn't reachable yet. In both cases the request never reached
 * the agent, so retrying is safe (idempotent) — including POST /chat. Retries a
 * few times with a capped backoff (~10s total), then surfaces the last result.
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

/** A single file's content hash from `GET /workspace` (Fs.TreeSnapshot). */
export interface TreeFile {
  path: string;
  hash: string;
}

export interface StartTurnResult {
  kind: "started";
  turnId: string;
}
export interface StartTurnConflict {
  kind: "conflict";
  activeTurnId?: string;
}
export interface StartTurnDenied {
  kind: "denied";
  retryAfter?: number;
}
export type StartTurnOutcome = StartTurnResult | StartTurnConflict | StartTurnDenied;

/** Thin client for the authoring-agent's HTTP contract. `baseUrl` is the running
 *  agent service (a local `telo` run today; the active runner's advertised URL later). */
export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  /** POST /chat → 200 { turnId } | 409 { activeTurnId } | 429 { retryAfter }. */
  async startTurn(conversationId: string, message: string): Promise<StartTurnOutcome> {
    const res = await fetchRetrying(this.url("/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message }),
    });
    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch (err) {
      throw new Error(
        `POST /chat returned an unreadable body (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 200) {
      if (typeof body.turnId !== "string" && typeof body.turnId !== "number") {
        throw new Error("POST /chat succeeded but returned no turnId.");
      }
      return { kind: "started", turnId: String(body.turnId) };
    }
    if (res.status === 409) return { kind: "conflict", activeTurnId: body.activeTurnId != null ? String(body.activeTurnId) : undefined };
    if (res.status === 429) return { kind: "denied", retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined };
    throw new Error(typeof body.error === "string" ? body.error : `POST /chat failed (${res.status})`);
  }

  /** POST /chat/{turnId}/abort → cancel the running turn. `supported: false`
   *  means the agent predates the abort endpoint (404) — the turn then runs to
   *  its natural end server-side. */
  async abortTurn(
    conversationId: string,
    turnId: string,
  ): Promise<{ supported: boolean; cancelled: boolean }> {
    const res = await fetchRetrying(this.url(`/chat/${encodeURIComponent(turnId)}/abort`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    if (res.status === 404) return { supported: false, cancelled: false };
    if (!res.ok) throw new Error(`POST /chat/${turnId}/abort failed (${res.status})`);
    const body = (await res.json()) as { cancelled?: unknown };
    return { supported: true, cancelled: body.cancelled === true };
  }

  /** GET /workspace → the agent's content-hash tree. */
  async workspaceTree(): Promise<TreeFile[]> {
    const res = await fetchRetrying(this.url("/workspace"));
    if (!res.ok) throw new Error(`GET /workspace failed (${res.status})`);
    const body = await res.json();
    return Array.isArray(body.files) ? body.files : [];
  }

  /** POST /workspace — apply an explicit write/delete change set (Fs.TreeSync). */
  async syncWorkspace(write: Array<{ path: string; content: string }>, del: string[]): Promise<void> {
    const res = await fetchRetrying(this.url("/workspace"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ write, delete: del }),
    });
    if (!res.ok) throw new Error(`POST /workspace failed (${res.status})`);
  }

  /** GET /workspace/file?path= → one file's contents. */
  async readWorkspaceFile(path: string): Promise<string> {
    const res = await fetchRetrying(this.url(`/workspace/file?path=${encodeURIComponent(path)}`));
    if (!res.ok) throw new Error(`GET /workspace/file failed (${res.status})`);
    const body = await res.json();
    return typeof body.content === "string" ? body.content : "";
  }

  /** GET /conversations/{id} → the agent-persisted history rows: the model's
   *  view of the conversation. Snapshotted after each turn so a later session
   *  can be seeded with exactly what the agent itself recorded. */
  async conversation(conversationId: string): Promise<AgentHistoryRow[]> {
    const res = await fetchRetrying(this.url(`/conversations/${encodeURIComponent(conversationId)}`));
    if (!res.ok) throw new Error(`GET /conversations failed (${res.status})`);
    const body = await res.json();
    const rows: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id),
        role: String(r.role),
        content: String(r.content),
        createdAt: String(r.created_at ?? ""),
      };
    });
  }

  /** POST /conversations/{id}/messages — seed a fresh per-session instance's DB
   *  with the rows a previous session persisted (idempotent by row id). */
  async importMessages(conversationId: string, messages: AgentHistoryRow[]): Promise<void> {
    const res = await fetchRetrying(
      this.url(`/conversations/${encodeURIComponent(conversationId)}/messages`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
      },
    );
    if (!res.ok) {
      throw new Error(`POST /conversations/${conversationId}/messages failed (${res.status})`);
    }
  }
}

export interface AgentStreamHandle {
  close(): void;
}

/**
 * Consume `GET /chat/{turnId}/events` — a resumable SSE stream of `{ id, data }`
 * envelopes. Replays from `fromId` (the client's last seen id) then tails live;
 * closes on a terminal `finish`/`error` part. Mirrors the run adapter's SSE
 * shape but with an agent-part parser (each frame's data is `{ data: <part> }`).
 */
export function openAgentStream(opts: {
  baseUrl: string;
  turnId: string;
  fromId: number;
  onPart: (part: AgentStreamPart, id: number) => void;
  onError: (err: Error) => void;
  onEnd: () => void;
}): AgentStreamHandle {
  const url = new URL(`${opts.baseUrl.replace(/\/$/, "")}/chat/${opts.turnId}/events`, window.location.href);
  if (opts.fromId > 0) url.searchParams.set("lastEventId", String(opts.fromId));
  const source = new EventSource(url.toString(), { withCredentials: false });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (e: MessageEvent) => {
    let envelope: { data?: AgentStreamPart };
    try {
      envelope = JSON.parse(e.data);
    } catch {
      return;
    }
    const part = envelope?.data;
    if (!part || typeof part.type !== "string") return;
    const id = Number(e.lastEventId) || 0;
    opts.onPart(part, id);
    if (part.type === "finish" || part.type === "error") {
      close();
      opts.onEnd();
    }
  };

  // A server-sent `event: error` frame (journal failed) carries data; a native
  // connection error does not. Only surface a hard failure when the socket is
  // closed — an auto-reconnect (readyState CONNECTING) is left to recover.
  source.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string" && data.length > 0) {
      close();
      opts.onError(parseErrorFrame(data));
      opts.onEnd();
    } else if (source.readyState === EventSource.CLOSED) {
      close();
      opts.onError(new Error("agent stream connection lost"));
    }
  });

  return { close };
}

function parseErrorFrame(data: string): Error {
  try {
    const parsed = JSON.parse(data);
    return new Error(typeof parsed.message === "string" ? parsed.message : "agent stream error");
  } catch {
    return new Error("agent stream error");
  }
}

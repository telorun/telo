import { ERR_UNAUTHENTICATED, TOKEN_REQUIRED_MESSAGE, withToken } from "./client";
import type { JournalRecord, TurnError } from "./types";

export interface AgentStreamHandle {
  close(): void;
}

/** Why an agent stream ended without its turn finishing: the turn's own error,
 *  by `code`, when the server sent one; a lost connection otherwise. */
export class AgentStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Consecutive connection attempts that deliver nothing before the stream is
 *  given up as lost. An attempt that delivers a frame resets the count. */
const MAX_FAILED_ATTEMPTS = 6;

function reconnectDelay(failedAttempts: number): number {
  return Math.min(250 * 2 ** failedAttempts, 5000);
}

/** Answers a fronting proxy gives while the upstream is (re)starting — ridden
 *  out like a dropped connection rather than read as the turn's ending. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Consume `GET /chat/{turnId}/events` — a resumable SSE stream of `{ id, data }`
 * journal records. Replays after `fromId` (the client's last seen id) then tails
 * live; ends after the turn's `finish` record, or with an `event: error` frame
 * carrying the turn's error `{ code, message }`.
 *
 * Read with `fetch` rather than `EventSource`, which cannot send the agent's
 * bearer token. What `EventSource` did by itself is done here: a dropped
 * connection is reopened from the last record id (`Last-Event-ID`, and
 * `?lastEventId=` for a proxy that strips the header), and a record at or below
 * that id — a replay overlapping what was already delivered — is dropped, so a
 * reconnect neither repeats nor skips one. A 401 ends the stream at once with
 * the auth message: no retry can succeed without a token.
 */
export function openAgentStream(opts: {
  baseUrl: string;
  turnId: string;
  fromId: number;
  token?: string;
  onRecord: (record: JournalRecord) => void;
  onError: (err: AgentStreamError) => void;
  onEnd: () => void;
}): AgentStreamHandle {
  const abort = new AbortController();
  let closed = false;
  let lastId = opts.fromId;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
  };
  const fail = (err: AgentStreamError, ended: boolean) => {
    close();
    opts.onError(err);
    if (ended) opts.onEnd();
  };

  const url = () => {
    const target = new URL(
      `${opts.baseUrl.replace(/\/$/, "")}/chat/${encodeURIComponent(opts.turnId)}/events`,
      window.location.href,
    );
    if (lastId > 0) target.searchParams.set("lastEventId", String(lastId));
    return target.toString();
  };
  const headers = () =>
    withToken(opts.token, {
      accept: "text/event-stream",
      ...(lastId > 0 ? { "last-event-id": String(lastId) } : {}),
    });

  // One frame; true when it ended the stream.
  const dispatch = (frame: SseFrame): boolean => {
    if (frame.event === "error") {
      fail(parseErrorFrame(frame.data), true);
      return true;
    }
    if (frame.event !== "message") return false;
    const envelope = JSON.parse(frame.data) as { data?: JournalRecord["data"]; id?: unknown };
    const part = envelope?.data;
    if (!part || typeof part.type !== "string") {
      throw new Error(`agent stream frame carries no record: ${frame.data.slice(0, 200)}`);
    }
    const id = typeof envelope.id === "number" ? envelope.id : Number(frame.id);
    if (!Number.isFinite(id)) throw new Error(`agent stream record has no numeric id: ${frame.data.slice(0, 200)}`);
    if (id <= lastId) return false;
    lastId = id;
    opts.onRecord({ id, data: part });
    if (part.type === "finish") {
      close();
      opts.onEnd();
      return true;
    }
    return false;
  };

  void (async () => {
    let failedAttempts = 0;
    for (;;) {
      if (closed) return;
      let delivered = false;
      try {
        const res = await fetch(url(), { headers: headers(), signal: abort.signal });
        if (res.status === 401) {
          fail(new AgentStreamError(TOKEN_REQUIRED_MESSAGE, ERR_UNAUTHENTICATED), false);
          return;
        }
        if (!res.ok && !TRANSIENT_STATUSES.has(res.status)) {
          fail(await refusalError(res), false);
          return;
        }
        if (!res.ok) await res.body?.cancel();
        else if (res.body) {
          for await (const frame of readFrames(res.body)) {
            delivered = true;
            let ended: boolean;
            try {
              ended = dispatch(frame);
            } catch (err) {
              // A frame this client cannot read or apply: reading it again
              // after a reconnect would fail the same way.
              fail(new AgentStreamError(`agent stream unreadable: ${err instanceof Error ? err.message : String(err)}`), false);
              return;
            }
            if (ended) return;
          }
        }
      } catch (err) {
        // Only the connection is read here: its failure — a network error, a
        // dropped body — is what a reconnect is for; our own close ends it.
        if (closed) return;
        if (!(err instanceof TypeError)) {
          fail(new AgentStreamError(`agent stream failed: ${err instanceof Error ? err.message : String(err)}`), false);
          return;
        }
      }
      if (closed) return;
      failedAttempts = delivered ? 0 : failedAttempts + 1;
      if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
        fail(new AgentStreamError("agent stream connection lost"), false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(failedAttempts)));
    }
  })();

  return { close };
}

/** A refused open (404 unknown turn, 410 removed, …), by the code its body carries. */
async function refusalError(res: Response): Promise<AgentStreamError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    return new AgentStreamError(
      typeof body.error === "string" ? body.error : `agent stream refused (${res.status})`,
      typeof body.code === "string" ? body.code : undefined,
    );
  } catch {
    return new AgentStreamError(`agent stream refused (${res.status}): ${text.slice(0, 200)}`);
  }
}

function parseErrorFrame(data: string): AgentStreamError {
  const parsed = JSON.parse(data) as Partial<TurnError>;
  return new AgentStreamError(
    typeof parsed.message === "string" ? parsed.message : "agent stream error",
    typeof parsed.code === "string" ? parsed.code : undefined,
  );
}

/** The SSE frames of a response body, per the event-stream format: fields up to
 *  a blank line, `data:` lines joined by newlines, comments ignored. A frame cut
 *  off by the end of the body is not dispatched. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: RegExpExecArray | null;
      while ((newline = /\r\n|\r|\n/.exec(buffer)) !== null) {
        // A lone `\r` at the end of the buffer may be the first half of `\r\n`.
        if (newline[0] === "\r" && newline.index === buffer.length - 1) break;
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        if (line === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n"), id };
          data = [];
          event = "";
          id = undefined;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id") id = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

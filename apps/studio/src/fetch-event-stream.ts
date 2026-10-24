/**
 * A server-sent event stream read with `fetch` rather than `EventSource`, which
 * cannot send a header — so a stream behind a bearer token (an agent's turn, a
 * runner session's events) can be read at all. What `EventSource` did by itself
 * is done here: a dropped connection is reopened (the caller builds each request,
 * so it resumes from the cursor it holds), and the answers a fronting proxy gives
 * while an upstream (re)starts are ridden out the same way.
 */

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Why a stream ended without the caller ending it. */
export type EventStreamFailure =
  /** A frame the caller could not read or apply; reading it again would fail the same way. */
  | { kind: "unreadable"; cause: unknown }
  /** Something other than the connection failed. */
  | { kind: "failed"; cause: unknown }
  /** Every attempt in a row delivered nothing. */
  | { kind: "lost" };

export interface FetchEventStreamOptions {
  /** One connection attempt. Called again for each reconnect, so the request
   *  carries whatever cursor and credentials hold at that moment. */
  connect(signal: AbortSignal): Promise<Response>;
  /** One frame; true when it ended the stream. A throw ends it as `unreadable`. */
  onFrame(frame: SseFrame): boolean;
  /** An answer that is neither a stream nor a transient proxy answer: it ends
   *  the stream, and the caller says why in its own words. */
  onRefused(response: Response): Promise<void> | void;
  onFailure(failure: EventStreamFailure): void;
}

export interface FetchEventStream {
  close(): void;
}

/** Consecutive connection attempts that deliver nothing before the stream is
 *  given up as lost. An attempt that delivers a frame resets the count. */
const MAX_FAILED_ATTEMPTS = 6;

/** Answers a fronting proxy gives while the upstream is (re)starting. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function reconnectDelay(failedAttempts: number): number {
  return Math.min(250 * 2 ** failedAttempts, 5000);
}

export function openFetchEventStream(options: FetchEventStreamOptions): FetchEventStream {
  const abort = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
  };
  const fail = (failure: EventStreamFailure) => {
    close();
    options.onFailure(failure);
  };

  void (async () => {
    let failedAttempts = 0;
    for (;;) {
      if (closed) return;
      let delivered = false;
      try {
        const res = await options.connect(abort.signal);
        if (!res.ok && !TRANSIENT_STATUSES.has(res.status)) {
          close();
          await options.onRefused(res);
          return;
        }
        if (!res.ok) await res.body?.cancel();
        else if (res.body) {
          for await (const frame of readSseFrames(res.body)) {
            if (closed) return;
            delivered = true;
            let ended: boolean;
            try {
              ended = options.onFrame(frame);
            } catch (cause) {
              fail({ kind: "unreadable", cause });
              return;
            }
            if (ended) {
              close();
              return;
            }
          }
        }
      } catch (cause) {
        // Only the connection is read here: its failure — a network error, a
        // dropped body — is what a reconnect is for; our own close ends it.
        if (closed) return;
        if (!(cause instanceof TypeError)) {
          fail({ kind: "failed", cause });
          return;
        }
      }
      if (closed) return;
      failedAttempts = delivered ? 0 : failedAttempts + 1;
      if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
        fail({ kind: "lost" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(failedAttempts)));
    }
  })();

  return { close };
}

/** The SSE frames of a response body, per the event-stream format: fields up to
 *  a blank line, `data:` lines joined by newlines, comments ignored. A frame cut
 *  off by the end of the body is not dispatched. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
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

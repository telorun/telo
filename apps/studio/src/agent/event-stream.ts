import { openFetchEventStream, type SseFrame } from "../fetch-event-stream";
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

/**
 * Consume `GET /chat/{turnId}/events` — a resumable SSE stream of `{ id, data }`
 * journal records. Replays after `fromId` (the client's last seen id) then tails
 * live; ends after the turn's `finish` record, or with an `event: error` frame
 * carrying the turn's error `{ code, message }`.
 *
 * Read through the fetch-based reader, since `EventSource` cannot send the
 * agent's bearer token: a dropped connection is reopened from the last record id (`Last-Event-ID`, and
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
  let closed = false;
  let lastId = opts.fromId;
  const close = () => {
    if (closed) return;
    closed = true;
    stream.close();
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

  const stream = openFetchEventStream({
    connect: (signal) => fetch(url(), { headers: headers(), signal }),
    onFrame: dispatch,
    onRefused: async (res) => {
      fail(
        res.status === 401
          ? new AgentStreamError(TOKEN_REQUIRED_MESSAGE, ERR_UNAUTHENTICATED)
          : await refusalError(res),
        false,
      );
    },
    onFailure: (failure) => {
      if (failure.kind === "lost") fail(new AgentStreamError("agent stream connection lost"), false);
      else if (failure.kind === "unreadable") fail(new AgentStreamError(`agent stream unreadable: ${describe(failure.cause)}`), false);
      else fail(new AgentStreamError(`agent stream failed: ${describe(failure.cause)}`), false);
    },
  });

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

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

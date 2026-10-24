import { openFetchEventStream } from "../../../fetch-event-stream";
import { refusalCode } from "../../identity-credentials";
import type { RunnerCredentials } from "../../runner-credentials";
import { isTerminal, type RunEvent } from "../../types";

export interface SessionEvents {
  close(): void;
}

export interface SessionEventsDeps {
  /** `…/v1/sessions/:id/events`. */
  url: string;
  credentials: RunnerCredentials;
  onEvent: (event: RunEvent) => void;
  /** The stream ended without being closed: refused, or lost. */
  onClosed: (reason: string) => void;
  /** The last event id a previous stream of this session delivered, and where
   *  each new one is reported — so a stream opened again after the session
   *  ended (a failed session resumed) carries on rather than replaying. */
  cursor: { value: number };
}

/** The SSE event names the runner sends; each payload carries its own `type`. */
const FORWARDED = new Set(["status", "progress", "debug", "app", "reachability", "run", "endpoints", "route"]);

/**
 * The session's event stream, read through the fetch-based reader so every
 * connection carries the session's credentials as headers.
 *
 * The first stream of a session replays from the start of the runner's buffer,
 * since the caller rebuilds its view of the session from it; a reconnect, and a
 * stream opened again, resume after the last event id seen (`Last-Event-ID`,
 * and `?lastEventId=` for a proxy that strips the header). A terminal status
 * ends the stream: the runner closes it there, and reconnecting would only
 * replay the ending.
 */
export function openSessionEvents(deps: SessionEventsDeps): SessionEvents {
  const cursor = deps.cursor;
  return openFetchEventStream({
    async connect(signal) {
      const target = new URL(deps.url, window.location.href);
      target.searchParams.set("lastEventId", String(cursor.value));
      const open = async () =>
        fetch(target.toString(), {
          headers: {
            ...(await deps.credentials.headers({ method: "GET", url: deps.url })),
            accept: "text/event-stream",
            "last-event-id": String(cursor.value),
          },
          signal,
        });
      let res = await open();
      if (!res.ok && deps.credentials.retry && (await deps.credentials.retry(res))) {
        await res.body?.cancel();
        res = await open();
      }
      // Not a proxy restarting, which the reader rides out: the runner cannot
      // check the sign-in, which the user is told.
      if (res.status === 503 && (await refusalCode(res)) === "identity_provider_unavailable") {
        throw new Error("the runner cannot reach the identity provider to check your sign-in. Try again.");
      }
      return res;
    },
    onFrame(frame) {
      if (frame.id !== undefined) {
        const id = Number.parseInt(frame.id, 10);
        if (Number.isFinite(id)) {
          if (id <= cursor.value) return false;
          cursor.value = id;
        }
      }
      if (frame.event === "gap") {
        // A fact about the STREAM, not output from the workload — workload bytes
        // travel the byte channel — so it is reported as a provisioning message.
        deps.onEvent({ type: "progress", phase: "boot", message: "stream reconnected — earlier events truncated" });
        return false;
      }
      if (!FORWARDED.has(frame.event)) return false;
      const event = JSON.parse(frame.data) as RunEvent;
      if (!event || typeof event !== "object" || typeof event.type !== "string") {
        throw new Error(`runner event carries no type: ${frame.data.slice(0, 200)}`);
      }
      deps.onEvent(event);
      return event.type === "status" && isTerminal(event.status);
    },
    async onRefused(res) {
      deps.onClosed(await refusedReason(res));
    },
    onFailure(failure) {
      deps.onClosed(
        failure.kind === "lost"
          ? "The runner's event stream was lost."
          : `The runner's event stream failed: ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)}`,
      );
    },
  });
}

async function refusedReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") return `The runner refused the event stream: ${body.message}`;
  } catch {
    // fall through to the status code
  }
  return `The runner refused the event stream (HTTP ${res.status}).`;
}

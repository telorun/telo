import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeSecretCredentials } from "../../../runner-credentials";
import type { RunEvent } from "../../../types";
import { openSessionEvents } from "../sse-client";

const URL_ = "http://runner.test/v1/sessions/s1/events";

function body(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const frame = (id: number, event: RunEvent) => `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

afterEach(() => vi.unstubAllGlobals());

describe("a session's event stream", () => {
  it("is read with the session's credentials, resumed after the last id, and ends on a terminal status", async () => {
    const ready: RunEvent = { type: "app", app: "api", state: "ready" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(body([frame(1, { type: "status", status: { kind: "running" } }), frame(2, ready)]))
      .mockResolvedValueOnce(body([frame(2, ready), frame(3, { type: "status", status: { kind: "stopped" } })]));
    vi.stubGlobal("fetch", fetchMock);
    const events: RunEvent[] = [];
    const closed = vi.fn();

    openSessionEvents({
      url: URL_,
      credentials: resumeSecretCredentials("sek"),
      cursor: { value: 0 },
      onEvent: (e) => events.push(e),
      onClosed: closed,
    });

    await vi.waitFor(() => expect(events).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([url, init]) => [String(url), init?.headers]);
    expect(requests).toEqual([
      [`${URL_}?lastEventId=0`, { authorization: "Bearer sek", accept: "text/event-stream", "last-event-id": "0" }],
      [`${URL_}?lastEventId=2`, { authorization: "Bearer sek", accept: "text/event-stream", "last-event-id": "2" }],
    ]);
    expect(events.map((e) => e.type)).toEqual(["status", "app", "status"]);
    expect(closed).not.toHaveBeenCalled();
  });

  it("says why when the runner refuses it", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "session_auth_required", message: "this route takes the session's credentials" }), { status: 401 })));
    const closed = vi.fn();
    openSessionEvents({ url: URL_, credentials: resumeSecretCredentials("sek"), cursor: { value: 0 }, onEvent() {}, onClosed: closed });
    await vi.waitFor(() =>
      expect(closed).toHaveBeenCalledWith("The runner refused the event stream: this route takes the session's credentials"),
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { ERR_UNAUTHENTICATED, TOKEN_REQUIRED_MESSAGE } from "../client";
import { openAgentStream, type AgentStreamError } from "../event-stream";
import type { JournalRecord } from "../types";

const AGENT = "http://agent.test";

function frame(record: JournalRecord): string {
  return `id: ${record.id}\nevent: message\ndata: ${JSON.stringify({ data: record.data })}\n\n`;
}

const delta = (id: number): JournalRecord => ({ id, data: { type: "text-delta", delta: `d${id}` } });
const finish = (id: number): JournalRecord => ({ id, data: { type: "finish", finishReason: "stop" } });

/** A body that delivers `frames` and then ends — a connection the agent (or a
 *  proxy between) dropped, unless the last frame ended the turn. */
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

function open(fetchMock: ReturnType<typeof vi.fn>, fromId = 0) {
  vi.stubGlobal("fetch", fetchMock);
  const records: JournalRecord[] = [];
  const errors: AgentStreamError[] = [];
  const ended = vi.fn();
  openAgentStream({
    baseUrl: AGENT,
    turnId: "t1",
    fromId,
    token: "tok",
    onRecord: (r) => records.push(r),
    onError: (e) => errors.push(e),
    onEnd: ended,
  });
  return { records, errors, ended };
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, call: number) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAgentStream", () => {
  it("reopens a dropped connection from the last record id, with the bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(body([frame(delta(3)), frame(delta(4))]))
      .mockResolvedValueOnce(body([frame(finish(5))]));
    const { ended } = open(fetchMock, 2);

    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestOf(fetchMock, 0)).toEqual({
      url: `${AGENT}/chat/t1/events?lastEventId=2`,
      headers: { accept: "text/event-stream", "last-event-id": "2", authorization: "Bearer tok" },
    });
    expect(requestOf(fetchMock, 1)).toEqual({
      url: `${AGENT}/chat/t1/events?lastEventId=4`,
      headers: { accept: "text/event-stream", "last-event-id": "4", authorization: "Bearer tok" },
    });
  });

  it("delivers every record exactly once across a reconnect whose replay overlaps", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(body([frame(delta(1)), frame(delta(2))]))
      .mockResolvedValueOnce(body([frame(delta(2)), frame(delta(3)), frame(finish(4))]));
    const { records, errors, ended } = open(fetchMock);

    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(records).toEqual([delta(1), delta(2), delta(3), finish(4)]);
    expect(errors).toEqual([]);
  });

  it("ends on a 401 with the auth message, without reconnecting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthenticated", code: ERR_UNAUTHENTICATED }), { status: 401 }),
    );
    const { records, errors } = open(fetchMock);

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: ERR_UNAUTHENTICATED, message: TOKEN_REQUIRED_MESSAGE });
    expect(records).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

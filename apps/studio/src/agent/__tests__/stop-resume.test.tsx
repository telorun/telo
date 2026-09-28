import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";

import type { RecordsPage } from "../records";
import type { JournalRecord, TurnRecords } from "../types";
import { AGENT_URL, FakeEventStream, installAgentGlobals, openAgent, stubAgent } from "./agent-harness";

const loaded: JournalRecord[] = [
  { id: 1, data: { type: "user-message", content: "build it", model: "m" } },
  { id: 2, data: { type: "text-delta", delta: "Working" } },
];
const failedTurn: TurnRecords = {
  turnId: "t1",
  status: "failed",
  error: { code: "ERR_JOURNAL_WRITER_LOST", message: "writer lost" },
  records: loaded,
};

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Stop", () => {
  it("posts the abort with no body, keeps the stream open while stopping, and ends the turn as Stopped", async () => {
    const fetchMock = stubAgent(
      { turns: [{ turnId: "t1", status: "running", error: null, records: loaded }], next: null },
      { "POST /chat/t1/abort": { status: 200, body: { cancelled: true } } },
    );
    const { result } = await openAgent();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const stream = FakeEventStream.opened[0];

    act(() => result.current.stop());

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === `${AGENT_URL}/chat/t1/abort`)).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === `${AGENT_URL}/chat/t1/abort`)!;
    expect(init).toEqual({ method: "POST" });
    expect(result.current.status).toBe("stopping");
    expect(stream.closed).toBe(false);

    act(() => stream.fail("ERR_INVOKE_CANCELLED", "cancelled by caller"));

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.messages[1]).toMatchObject({ id: "t1", stopped: true, pending: false });
    expect(result.current.messages[1]).not.toHaveProperty("error");
    expect(result.current.error).toBeNull();
    expect(result.current.canRetry).toBe(false);
  });

  it("renders a turn another client stopped as Stopped, from the turn's status on the agent", async () => {
    const page: RecordsPage = { turns: [{ turnId: "t1", status: "running", error: null, records: loaded }], next: null };
    const fetchMock = stubAgent(page);
    const { result } = await openAgent();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    // Another client's abort: the agent now reports the turn aborted.
    page.turns[0] = {
      turnId: "t1",
      status: "aborted",
      error: { code: "ERR_INVOKE_CANCELLED", message: "cancelled by caller" },
      records: [],
    };

    act(() => FakeEventStream.opened[0].fail("ERR_INVOKE_CANCELLED", "cancelled by caller"));

    await waitFor(() => expect(result.current.messages[1]).toMatchObject({ id: "t1", stopped: true, pending: false }));
    expect(
      fetchMock.mock.calls.some(([url]) => {
        const read = new URL(String(url));
        return read.pathname.endsWith("/records") && read.searchParams.get("fromTurn") === "t1";
      }),
    ).toBe(true);
    expect(result.current.messages[1]).not.toHaveProperty("error");
    expect(result.current.error).toBeNull();
    expect(result.current.canRetry).toBe(false);
  });
});

describe("Resume", () => {
  it("continues the turn and re-attaches from its last record, the new attempt under a divider on the same reply", async () => {
    const fetchMock = stubAgent(
      { turns: [failedTurn], next: null },
      { "POST /chat/t1/continue": { status: 200, body: { turnId: "t1", fromId: 2 } } },
    );
    const { result } = await openAgent();
    expect(result.current.canRetry).toBe(true);

    act(() => result.current.retry());

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === `${AGENT_URL}/chat/t1/continue`)!;
    expect(init).toEqual({ method: "POST" });
    const stream = FakeEventStream.opened[0];
    expect(stream.url).toBe(`${AGENT_URL}/chat/t1/events?lastEventId=2`);

    act(() => {
      stream.emit({ id: 3, data: { type: "turn-continued", note: "TURN CONTINUED: …", model: "m" } });
      stream.emit({ id: 4, data: { type: "text-delta", delta: "Done." } });
      stream.emit({ id: 5, data: { type: "finish", finishReason: "stop" } });
    });

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({
      id: "t1",
      completed: true,
      parts: [
        { kind: "text", text: "Working" },
        { kind: "continued" },
        { kind: "text", text: "Done." },
      ],
    });
    expect(result.current.messages[1]).not.toHaveProperty("error", expect.anything());
  });

  it("attaches to the turn when the agent answers it is still running", async () => {
    stubAgent(
      { turns: [failedTurn], next: null },
      {
        "POST /chat/t1/continue": {
          status: 409,
          body: { code: "ERR_TURN_IN_PROGRESS", error: "running", activeTurnId: "t1" },
        },
      },
    );
    const { result } = await openAgent();

    act(() => result.current.retry());

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect(FakeEventStream.opened[0].url).toBe(`${AGENT_URL}/chat/t1/events?lastEventId=2`);
    expect(result.current.status).toBe("streaming");
    expect(result.current.error).toBeNull();
  });

  it("says why a turn cannot be continued", async () => {
    stubAgent(
      { turns: [failedTurn], next: null },
      {
        "POST /chat/t1/continue": {
          status: 409,
          body: { code: "ERR_TURN_NOT_CONTINUABLE", error: "later turn", reason: "superseded" },
        },
      },
    );
    const { result } = await openAgent();

    act(() => result.current.retry());

    await waitFor(() =>
      expect(result.current.error).toBe("A later turn followed this one; only the last turn can be resumed."),
    );
    expect(FakeEventStream.opened).toHaveLength(0);
  });
});

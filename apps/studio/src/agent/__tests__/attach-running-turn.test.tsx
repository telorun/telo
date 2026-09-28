import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";

import { transcriptFromTurns } from "../records";
import type { JournalRecord, TurnRecords } from "../types";
import { AGENT_URL, CONVERSATION, FakeEventStream, installAgentGlobals, openAgent, stubAgent } from "./agent-harness";

const finishedTurn: TurnRecords = {
  turnId: "t1",
  status: "finished",
  error: null,
  records: [
    { id: 1, data: { type: "user-message", content: "first", model: "m" } },
    { id: 2, data: { type: "text-delta", delta: "Done." } },
    { id: 3, data: { type: "finish", finishReason: "stop" } },
  ],
};
const loaded: JournalRecord[] = [
  { id: 1, data: { type: "user-message", content: "build it", model: "m" } },
  { id: 2, data: { type: "text-delta", delta: "Working" } },
];
const live: JournalRecord[] = [
  { id: 3, data: { type: "text-delta", delta: " on it." } },
  { id: 4, data: { type: "finish", finishReason: "stop" } },
];

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AgentProvider on open", () => {
  it("attaches to a running last turn from its last record id and appends live records once", async () => {
    const fetchMock = stubAgent({
      turns: [finishedTurn, { turnId: "t2", status: "running", error: null, records: loaded }],
      next: null,
    });

    const { result } = await openAgent();

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${AGENT_URL}/conversations/${CONVERSATION}/records`);
    const stream = FakeEventStream.opened[0];
    expect(stream.url).toBe(`${AGENT_URL}/chat/t2/events?lastEventId=2`);
    expect(result.current.status).toBe("streaming");

    act(() => {
      for (const record of live) stream.emit(record);
    });

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.messages).toEqual(
      transcriptFromTurns([finishedTurn, { turnId: "t2", status: "finished", error: null, records: [...loaded, ...live] }]),
    );
  });
});

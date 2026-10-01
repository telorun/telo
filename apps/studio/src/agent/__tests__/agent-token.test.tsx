import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { WorkspaceBridge } from "../types";
import { AGENT_URL, FakeEventStream, installAgentGlobals, stubAgent } from "./agent-harness";

const bridge: WorkspaceBridge = {
  snapshot: async () => new Map(),
  readFile: async () => "",
  applyChanges: async () => undefined,
  editorFile: () => null,
};

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the override's token", () => {
  it("rides every request to that agent, and its identity is asked once", async () => {
    const fetchMock = stubAgent(
      {
        turns: [
          {
            turnId: "t1",
            status: "running",
            error: null,
            records: [{ id: 1, data: { type: "user-message", content: "build it", model: "m" } }],
          },
        ],
        next: null,
      },
      {
        "GET /capabilities": {
          status: 200,
          body: { agent: { name: "AuthoringAgent", version: "0.9.0" }, prompt: { id: "ab12" }, auth: "bearer" },
        },
      },
    );
    const { result } = renderHook(() => useAgent(), {
      wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
    });
    act(() => result.current.setOverrideToken("tok"));
    act(() => {
      result.current.registerWorkspace(bridge);
      result.current.setConversation("ws");
    });

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    await waitFor(() => expect(result.current.identity).toEqual({
      state: "known",
      identity: { name: "AuthoringAgent", version: "0.9.0", promptId: "ab12", auth: "bearer" },
    }));

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    }));
    expect(requests.filter((r) => r.path === "/capabilities")).toHaveLength(1);
    expect(requests.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/conversations/conv-1/records", "/chat/t1/events", "/capabilities"]),
    );
    for (const r of requests) expect(r).toMatchObject({ authorization: "Bearer tok" });
    expect(FakeEventStream.opened[0].url).toBe(`${AGENT_URL}/chat/t1/events?lastEventId=1`);
  });
});

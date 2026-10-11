import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import { AGENT_PANEL_DEFAULT_WIDTH, saveAgentSettings } from "../storage";
import {
  AGENT_URL,
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  finishedTurn,
  installAgentGlobals,
  stubAgent,
  type Answer,
} from "./agent-harness";

const startsTurn = { "POST /chat": { status: 200, body: { turnId: "t2" } } };
const finishedPage = (): RecordsPage => ({ turns: [finishedTurn("t1", "first")], next: null });
const runningPage = (): RecordsPage => ({
  turns: [
    {
      turnId: "t1",
      status: "running",
      error: null,
      records: [{ id: 1, data: { type: "user-message", content: "build it", model: "m" } }],
    },
  ],
  next: null,
});

function turnsStarted(fetchMock: ReturnType<typeof stubAgent>): string[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")
    .map(([, init]) => (JSON.parse(String(init?.body)) as { message: string }).message);
}

function mount() {
  return renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
}

function openWorkspace(view: ReturnType<typeof mount>) {
  act(() => {
    view.result.current.registerWorkspace(fakeWorkspaceBridge);
    view.result.current.setConversation("ws");
  });
}

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("a request made with no workspace open", () => {
  it("opens the panel and is sent only once the workspace's conversation has been read", async () => {
    saveAgentSettings({ overrideUrl: AGENT_URL, panelOpen: false, panelWidth: AGENT_PANEL_DEFAULT_WIDTH, questionCards: true });
    let settle!: (answer: Answer) => void;
    const records = new Promise<Answer>((resolve) => {
      settle = resolve;
    });
    const fetchMock = stubAgent(finishedPage(), {
      ...startsTurn,
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
      [`GET /conversations/${CONVERSATION}/records`]: { wait: records },
    });
    const view = mount();

    act(() => view.result.current.sendOnOpen("Build a ticket API"));
    expect(view.result.current.panelOpen).toBe(true);
    openWorkspace(view);
    await waitFor(() => expect(view.result.current.conversation?.id).toBe(CONVERSATION));
    expect(turnsStarted(fetchMock)).toEqual([]);

    await act(async () => settle({ status: 200, body: finishedPage() }));

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual(["Build a ticket API"]));
    const texts = view.result.current.messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(texts).toEqual(["first", "Build a ticket API"]);
  });

  it("is queued behind a turn the workspace's conversation is still running", async () => {
    const fetchMock = stubAgent(runningPage(), startsTurn);
    const view = mount();

    act(() => view.result.current.sendOnOpen("Build a ticket API"));
    openWorkspace(view);

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    await waitFor(() =>
      expect(view.result.current.composer.queued).toEqual({ text: "Build a ticket API", attachments: [] }),
    );
    expect(turnsStarted(fetchMock)).toEqual([]);
  });

  it("is dropped when the workspace closes before it could be sent", async () => {
    const fetchMock = stubAgent(finishedPage(), startsTurn);
    const view = mount();

    act(() => view.result.current.sendOnOpen("Build a ticket API"));
    act(() => view.result.current.setConversation(null));
    openWorkspace(view);

    await waitFor(() => expect(view.result.current.messages.length).toBeGreaterThan(0));
    expect(turnsStarted(fetchMock)).toEqual([]);
    expect(view.result.current.composer.queued).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import { AGENT_PANEL_DEFAULT_WIDTH, loadConversationId, saveAgentSettings, saveConversationId } from "../storage";
import {
  AGENT_URL,
  FakeEventStream,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  requestsMade,
  stubAgent,
  type Answer,
} from "./agent-harness";

// The agent exists only once a send launches it: a fresh instance holding no
// conversation, whatever id this workspace last pointed at.
vi.mock("../launch", () => ({
  AGENT_APP_NAME: "authoring-agent",
  launchAgentSession: vi.fn(async () => ({
    agentUrl: AGENT_URL,
    sessionId: "s1",
    deleteUrl: "http://runner.test/v1/sessions/s1",
    stop: async () => undefined,
  })),
}));

beforeEach(() => {
  FakeEventStream.opened = [];
  saveAgentSettings({ overrideUrl: "", panelOpen: true, panelWidth: AGENT_PANEL_DEFAULT_WIDTH, questionCards: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function open() {
  const view = renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
  act(() => {
    view.result.current.setRunner("http://runner.test");
    view.result.current.registerWorkspace(fakeWorkspaceBridge);
    view.result.current.setConversation("ws");
  });
  return view;
}

const chatBody = (fetchMock: ReturnType<typeof stubAgent>) => {
  const [, chat] = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")!;
  return JSON.parse(String(chat?.body));
};

describe("a workspace opened before any agent is reachable", () => {
  const serving: Record<string, Answer> = {
    "GET /capabilities": capabilities(),
    "POST /conversations": { status: 201, body: conversation({ id: "n1", title: null, revision: 0 }) },
    "GET /conversations/n1": { status: 200, body: conversation({ id: "n1", title: null, revision: 0 }) },
    "POST /chat": { status: 200, body: { turnId: "t1" } },
  };

  it("shows a draft and stores no pointer", () => {
    stubAgent({ turns: [], next: null });
    const { result } = open();

    expect(result.current.draft).toBe(true);
    expect(loadConversationId("ws")).toBeNull();
  });

  it.each([
    ["no pointer", null],
    ["a pointer the launched agent never held", "stale"],
  ])("with %s, the first send creates the conversation on the launched agent and sends", async (pointerKind, pointer) => {
    if (pointer) saveConversationId("ws", pointer);
    const fetchMock = stubAgent({ turns: [], next: null }, { ...serving });
    const { result } = open();
    expect(result.current.draft).toBe(true);

    act(() => result.current.send("hello"));

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    const made = requestsMade(fetchMock);
    expect(made.filter((r) => r === "POST /conversations")).toHaveLength(1);
    expect(made.some((r) => r.startsWith("GET /conversations/stale"))).toBe(false);
    expect(chatBody(fetchMock)).toEqual({ conversationId: "n1", message: "hello" });
    expect(result.current.error).toBeNull();
    expect(loadConversationId("ws")).toBe("n1");
  });

  it("sends under the stored id to an agent that does not serve conversations", async () => {
    saveConversationId("ws", "kept");
    const fetchMock = stubAgent({ turns: [], next: null }, { "POST /chat": serving["POST /chat"] });
    const { result } = open();

    act(() => result.current.send("hello"));

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    expect(requestsMade(fetchMock)).not.toContain("POST /conversations");
    expect(chatBody(fetchMock)).toEqual({ conversationId: "kept", message: "hello" });
    expect(loadConversationId("ws")).toBe("kept");
  });

  it("New conversation before any agent drops the pointer, and the first send creates", async () => {
    saveConversationId("ws", "stale");
    const fetchMock = stubAgent({ turns: [], next: null }, { ...serving });
    const { result } = open();

    act(() => result.current.clearConversation());
    expect(result.current.draft).toBe(true);
    expect(loadConversationId("ws")).toBeNull();

    act(() => result.current.send("hello"));

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    expect(chatBody(fetchMock)).toEqual({ conversationId: "n1", message: "hello" });
    expect(result.current.error).toBeNull();
  });
});

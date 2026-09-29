import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import { loadConversationId, saveConversationId } from "../storage";
import { LOCAL_PREFIXES } from "../../storage-keys";
import {
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  finishedTurn,
  installAgentGlobals,
  openAgent,
  openConversations,
  refused,
  requestsMade,
  stubAgent,
  type Answer,
} from "./agent-harness";

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const focus = () => act(() => void window.dispatchEvent(new Event("focus")));

const records = (fetchMock: ReturnType<typeof stubAgent>, id = CONVERSATION) =>
  requestsMade(fetchMock).filter((r) => r === `GET /conversations/${id}/records`).length;

describe("the workspace's conversation", () => {
  it("opens the most recent live conversation when the agent no longer has the last-opened one", async () => {
    saveConversationId("ws", "gone");
    const fetchMock = stubAgent(
      { turns: [], next: null },
      {
        "GET /capabilities": capabilities(),
        "GET /conversations/gone": refused(404, "ERR_CONVERSATION_NOT_FOUND"),
        "GET /conversations/gone/records": refused(404, "ERR_CONVERSATION_NOT_FOUND"),
        "GET /conversations": { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } },
        "GET /conversations/c2/records": { status: 200, body: { turns: [finishedTurn("t1", "hi")], next: null } },
      },
    );

    const { result } = await openConversations("c2");

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(requestsMade(fetchMock)).toContain("GET /conversations?limit=1");
    expect(loadConversationId("ws")).toBe("c2");
    expect(result.current.error).toBeNull();
  });

  it("opens a draft with no conversation, and creates it on the first send", async () => {
    localStorage.removeItem(LOCAL_PREFIXES.agentConv + "ws");
    const fetchMock = stubAgent(
      { turns: [], next: null },
      {
        "GET /capabilities": capabilities(),
        "GET /conversations": { status: 200, body: { conversations: [], next: null } },
        "POST /conversations": { status: 201, body: conversation({ id: "new", title: null, revision: 0 }) },
        "POST /chat": { status: 200, body: { turnId: "t1" } },
      },
    );
    const { result } = renderHook(() => useAgent(), {
      wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
    });
    act(() => {
      result.current.registerWorkspace(fakeWorkspaceBridge);
      result.current.setConversation("ws");
    });
    await waitFor(() => expect(requestsMade(fetchMock)).toContain("GET /conversations?limit=1"));
    expect(result.current.draft).toBe(true);
    expect(requestsMade(fetchMock)).not.toContain("POST /conversations");

    act(() => result.current.send("hello"));

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const made = requestsMade(fetchMock);
    expect(made.indexOf("POST /conversations")).toBeLessThan(made.indexOf("POST /chat"));
    const [, chat] = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")!;
    expect(JSON.parse(String(chat?.body))).toEqual({ conversationId: "new", message: "hello" });
    expect(result.current.conversation?.id).toBe("new");
    expect(loadConversationId("ws")).toBe("new");
  });

  it("without `features`, mints the id itself and never asks for a conversation", async () => {
    const fetchMock = stubAgent(
      { turns: [finishedTurn("t1", "hi")], next: null },
      { "GET /capabilities": capabilities({ features: undefined }) },
    );
    const { result } = await openAgent();
    await waitFor(() => expect(result.current.identity?.state).toBe("known"));

    act(() => result.current.clearConversation());

    const minted = loadConversationId("ws");
    expect(minted).not.toBe(CONVERSATION);
    expect(result.current.conversationId).toBe(minted);
    expect(result.current.features).toEqual({ conversations: false, truncation: false, branching: false });
    expect(requestsMade(fetchMock).filter((r) => /^(GET|POST|PATCH|DELETE) \/conversations(\/[^/]+)?(\?|$)/.test(r))).toEqual([]);
  });
});

describe("other clients", () => {
  it("re-reads the transcript when the revision moved", async () => {
    const page: RecordsPage = { turns: [finishedTurn("t1", "hi")], next: null };
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation({ revision: 1 }) },
    };
    const fetchMock = stubAgent(page, routes);
    const { result } = await openConversations();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    page.turns.push(finishedTurn("t2", "again"));
    routes[`GET /conversations/${CONVERSATION}`] = { status: 200, body: conversation({ revision: 2 }) };
    const before = records(fetchMock);
    focus();

    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    expect(records(fetchMock)).toBe(before + 1);
    expect(result.current.conversation?.revision).toBe(2);
  });

  it("does not re-read under a running turn, and does once its stream ends", async () => {
    const running = finishedTurn("t1", "hi");
    const page: RecordsPage = {
      turns: [{ ...running, status: "running", records: running.records.slice(0, 2) }],
      next: null,
    };
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation({ revision: 1 }) },
    };
    const fetchMock = stubAgent(page, routes);
    const { result } = await openConversations();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const before = records(fetchMock);

    routes[`GET /conversations/${CONVERSATION}`] = { status: 200, body: conversation({ revision: 2, title: "Renamed" }) };
    focus();
    await waitFor(() => expect(result.current.conversation?.title).toBe("Renamed"));
    expect(records(fetchMock)).toBe(before);

    page.turns[0] = running;
    act(() => FakeEventStream.opened[0].emit(running.records[2]));

    await waitFor(() => expect(records(fetchMock)).toBe(before + 1));
  });

  it("leaves a deleted conversation for the most recent remaining one, saying why", async () => {
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
      "GET /conversations": { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } },
      "GET /conversations/c2/records": { status: 200, body: { turns: [], next: null } },
    };
    stubAgent({ turns: [finishedTurn("t1", "hi")], next: null }, routes);
    const { result } = await openConversations();

    routes[`GET /conversations/${CONVERSATION}`] = refused(410, "ERR_CONVERSATION_REMOVED");
    focus();

    await waitFor(() => expect(result.current.conversation?.id).toBe("c2"));
    expect(result.current.error).toBe("This conversation was deleted. (ERR_CONVERSATION_REMOVED)");
  });
});

describe("turn actions", () => {
  const twoTurns = (): RecordsPage => ({ turns: [finishedTurn("t1", "first"), finishedTurn("t2", "second")], next: null });

  it("Retry removes the turn and everything after it, then sends its request again", async () => {
    const fetchMock = stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation({ revision: 3 }) },
      [`DELETE /conversations/${CONVERSATION}/turns`]: {
        status: 200,
        body: { removedTurns: 1, conversation: conversation({ revision: 4 }) },
      },
      "POST /chat": { status: 200, body: { turnId: "t3" } },
    });
    const { result } = await openConversations();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));

    await act(() => result.current.resendFrom("t2", "second"));

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const made = requestsMade(fetchMock);
    const truncation = made.indexOf(`DELETE /conversations/${CONVERSATION}/turns?from=t2&revision=3`);
    expect(truncation).toBeGreaterThan(-1);
    expect(truncation).toBeLessThan(made.indexOf("POST /chat"));
    expect(result.current.messages.map((m) => m.id)).toEqual(["t1:user", "t1", "t3:user", "t3"]);
  });

  it("Branch opens the new conversation", async () => {
    const fetchMock = stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
      [`POST /conversations/${CONVERSATION}/branch`]: {
        status: 201,
        body: conversation({ id: "b1", title: "Build a server (branch)" }),
      },
      "GET /conversations/b1/records": { status: 200, body: { turns: [finishedTurn("x1", "first")], next: null } },
    });
    const { result } = await openConversations();
    await waitFor(() => expect(result.current.messages).toHaveLength(4));

    await act(() => result.current.branchFrom("t1"));

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/branch"))!;
    expect(JSON.parse(String(init?.body))).toEqual({ throughTurnId: "t1" });
    expect(result.current.conversation?.id).toBe("b1");
    expect(loadConversationId("ws")).toBe("b1");
  });
});

describe("deleting a conversation", () => {
  it("with a running turn: asks first, then aborts it, waits for its stream to end, and deletes", async () => {
    const other = "c9";
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
      [`DELETE /conversations/${other}`]: refused(409, "ERR_TURN_IN_PROGRESS", { activeTurnId: "r1" }),
      "POST /chat/r1/abort": { status: 200, body: { cancelled: true } },
    };
    const fetchMock = stubAgent({ turns: [finishedTurn("t1", "hi")], next: null }, routes);
    const { result } = await openConversations();

    await expect(result.current.deleteConversation(other, false)).resolves.toBe("running");

    let settled = false;
    const deleting = result.current.deleteConversation(other, true).then((outcome) => {
      settled = true;
      return outcome;
    });
    await waitFor(() => expect(FakeEventStream.opened.some((s) => s.url.includes("/chat/r1/events"))).toBe(true));
    expect(requestsMade(fetchMock)).toContain("POST /chat/r1/abort");
    expect(settled).toBe(false);

    routes[`DELETE /conversations/${other}`] = { status: 204, body: null };
    act(() => FakeEventStream.opened.find((s) => s.url.includes("/chat/r1/events"))!.fail("ERR_INVOKE_CANCELLED", "stopped"));

    await expect(deleting).resolves.toBe("deleted");
    expect(requestsMade(fetchMock).filter((r) => r === `DELETE /conversations/${other}`)).toHaveLength(3);
  });
});

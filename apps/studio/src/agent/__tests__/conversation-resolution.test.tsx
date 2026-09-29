import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, CONVERSATION_POLL_MS, useAgent } from "../context";
import { loadConversationId } from "../storage";
import { LOCAL_PREFIXES } from "../../storage-keys";
import {
  CONVERSATION,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  finishedTurn,
  installAgentGlobals,
  refused,
  requestsMade,
  stubAgent,
  type Answer,
} from "./agent-harness";

// A rejected fetch is retried with back-off before it fails, so the clock is
// driven by the test.
beforeEach(() => {
  vi.useFakeTimers();
  installAgentGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const POINTER = LOCAL_PREFIXES.agentConv + "ws";
const FAILED = "Failed to open the workspace's conversation: ";

/** Advance the clock until `check` holds. */
async function until(check: () => void): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      check();
      return;
    } catch {
      await act(() => vi.advanceTimersByTimeAsync(250));
    }
  }
  check();
}

const tick = () => act(() => vi.advanceTimersByTimeAsync(CONVERSATION_POLL_MS));

function open() {
  const view = renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
  act(() => {
    view.result.current.registerWorkspace(fakeWorkspaceBridge);
    view.result.current.setConversation("ws");
  });
  return view;
}

const count = (fetchMock: ReturnType<typeof stubAgent>, request: string) =>
  requestsMade(fetchMock).filter((r) => r === request).length;

const failures: [string, Answer, string][] = [
  ["a 500", refused(500, "ERR_INTERNAL"), "refused: ERR_INTERNAL (ERR_INTERNAL)"],
  ["a rejected fetch", { reject: "Failed to fetch" }, "Failed to fetch"],
];

describe.each(failures)("resolving the workspace's conversation fails with %s", (_, failure, said) => {
  const pointed = `GET /conversations/${CONVERSATION}`;

  /** The provider with the pointer's resolution failing, once its error shows. */
  async function unresolved(routes: Record<string, Answer>) {
    routes["GET /capabilities"] = capabilities();
    routes[pointed] = failure;
    const fetchMock = stubAgent({ turns: [finishedTurn("t1", "hi")], next: null }, routes);
    const stored = localStorage.getItem(POINTER);
    const view = open();
    await until(() => expect(view.result.current.error).toBe(FAILED + said));
    await until(() => expect(view.result.current.messages).toHaveLength(2));
    return { fetchMock, result: view.result, stored };
  }

  it("keeps the pointed conversation open, unadopted, with the error shown", async () => {
    const { fetchMock, result, stored } = await unresolved({});

    expect(result.current.conversationId).toBe(CONVERSATION);
    expect(result.current.conversation).toBeNull();
    expect(result.current.draft).toBe(false);

    const reads = count(fetchMock, `${pointed}/records`);
    const asked = count(fetchMock, pointed);
    await tick();
    await until(() => expect(count(fetchMock, pointed)).toBeGreaterThan(asked));
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(count(fetchMock, `${pointed}/records`)).toBe(reads);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.conversationId).toBe(CONVERSATION);
    expect(result.current.error).toBe(FAILED + said);
    expect(localStorage.getItem(POINTER)).toBe(stored);
  });

  it("adopts it on the next tick that succeeds, clears its error, and the revision poll takes over", async () => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await unresolved(routes);

    routes[pointed] = { status: 200, body: conversation() };
    await tick();
    await until(() => expect(result.current.conversation?.id).toBe(CONVERSATION));
    expect(result.current.error).toBeNull();
    expect(loadConversationId("ws")).toBe(CONVERSATION);

    const asked = count(fetchMock, pointed);
    await tick();
    await until(() => expect(count(fetchMock, pointed)).toBe(asked + 1));
  });

  it("leaves an error set since the failure shown when the retry succeeds", async () => {
    const routes: Record<string, Answer> = {
      [`POST /conversations/${CONVERSATION}/branch`]: refused(500, "ERR_BRANCH_FAILED"),
    };
    const { result } = await unresolved(routes);
    await act(() => result.current.branchFrom("t1"));
    const unrelated = "refused: ERR_BRANCH_FAILED (ERR_BRANCH_FAILED)";
    expect(result.current.error).toBe(unrelated);

    routes[pointed] = { status: 200, body: conversation() };
    await tick();
    await until(() => expect(result.current.conversation?.id).toBe(CONVERSATION));
    expect(result.current.error).toBe(unrelated);
  });

  it("fails a send while the pointer still cannot be read, creating nothing and keeping the message", async () => {
    const { fetchMock, result, stored } = await unresolved({});

    act(() => result.current.send("hello"));

    await until(() => expect(result.current.status).toBe("error"));
    const made = requestsMade(fetchMock);
    expect(made).not.toContain("POST /conversations");
    expect(made).not.toContain("POST /chat");
    expect(result.current.error).toBe(said);
    expect(result.current.messages.at(-2)).toMatchObject({ role: "user", text: "hello", local: true });
    expect(result.current.canRetry).toBe(true);
    expect(localStorage.getItem(POINTER)).toBe(stored);
  });

  it("on a send answered 410, opens the most recent conversation with the notice instead of creating one", async () => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await unresolved(routes);
    routes[pointed] = refused(410, "ERR_CONVERSATION_REMOVED");
    routes["GET /conversations"] = { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } };
    routes["GET /conversations/c2/records"] = { status: 200, body: { turns: [finishedTurn("x1", "older")], next: null } };

    act(() => result.current.send("hello"));

    await until(() => expect(result.current.conversation?.id).toBe("c2"));
    await until(() => expect(result.current.messages).toHaveLength(4));
    const made = requestsMade(fetchMock);
    expect(made).toContain("GET /conversations?limit=1");
    expect(made).not.toContain("POST /conversations");
    expect(made).not.toContain("POST /chat");
    expect(result.current.error).toBe("This conversation was deleted. (ERR_CONVERSATION_REMOVED)");
    expect(result.current.messages.at(-2)).toMatchObject({ role: "user", text: "hello", local: true });
    expect(result.current.canRetry).toBe(true);
  });

  it("on a send answered 404 with nothing left, opens a draft with the notice instead of creating one", async () => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await unresolved(routes);
    routes[pointed] = refused(404, "ERR_CONVERSATION_NOT_FOUND");
    routes["GET /conversations"] = { status: 200, body: { conversations: [], next: null } };

    act(() => result.current.send("hello"));

    await until(() => expect(result.current.draft).toBe(true));
    await until(() => expect(result.current.status).toBe("error"));
    const made = requestsMade(fetchMock);
    expect(made).toContain("GET /conversations?limit=1");
    expect(made).not.toContain("POST /conversations");
    expect(made).not.toContain("POST /chat");
    expect(result.current.error).toBe("The agent no longer has this conversation. (ERR_CONVERSATION_NOT_FOUND)");
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "hello", local: true });
    expect(result.current.canRetry).toBe(true);
  });

  it("with no pointer and the list failing, shows a draft and the error, then opens the most recent on the next tick", async () => {
    localStorage.removeItem(POINTER);
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      "GET /conversations": failure,
      "GET /conversations/c2/records": { status: 200, body: { turns: [finishedTurn("x1", "older")], next: null } },
    };
    stubAgent({ turns: [], next: null }, routes);
    const { result } = open();

    await until(() => expect(result.current.error).toBe(FAILED + said));
    expect(result.current.draft).toBe(true);
    expect(localStorage.getItem(POINTER)).toBeNull();

    routes["GET /conversations"] = { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } };
    await tick();

    await until(() => expect(result.current.conversation?.id).toBe("c2"));
    await until(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.error).toBeNull();
  });

  it("a 410 followed by a failing list shows both", async () => {
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [pointed]: { status: 200, body: conversation() },
    };
    stubAgent({ turns: [finishedTurn("t1", "hi")], next: null }, routes);
    const stored = localStorage.getItem(POINTER);
    const { result } = open();
    await until(() => expect(result.current.conversation?.id).toBe(CONVERSATION));

    routes[pointed] = refused(410, "ERR_CONVERSATION_REMOVED");
    routes["GET /conversations"] = failure;
    await tick();

    await until(() =>
      expect(result.current.error).toBe(`This conversation was deleted. (ERR_CONVERSATION_REMOVED) ${FAILED}${said}`),
    );
    expect(result.current.draft).toBe(true);
    expect(localStorage.getItem(POINTER)).toBe(stored);
  });

  const GONE = {
    404: { code: "ERR_CONVERSATION_NOT_FOUND", notice: "The agent no longer has this conversation. (ERR_CONVERSATION_NOT_FOUND)" },
    410: { code: "ERR_CONVERSATION_REMOVED", notice: "This conversation was deleted. (ERR_CONVERSATION_REMOVED)" },
  } as const;

  /** The open conversation answers `gone` to the poll and the fallback list
   *  fails: a draft with both errors. */
  async function goneThenFailedList(gone: 404 | 410, routes: Record<string, Answer>) {
    routes["GET /capabilities"] = capabilities();
    routes[pointed] = { status: 200, body: conversation() };
    const fetchMock = stubAgent({ turns: [finishedTurn("t1", "hi")], next: null }, routes);
    const view = open();
    await until(() => expect(view.result.current.conversation?.id).toBe(CONVERSATION));
    routes[pointed] = refused(gone, GONE[gone].code);
    routes["GET /conversations"] = failure;
    await tick();
    await until(() => expect(view.result.current.error).toBe(`${GONE[gone].notice} ${FAILED}${said}`));
    expect(view.result.current.draft).toBe(true);
    return { fetchMock, result: view.result };
  }

  it.each([404, 410] as const)("the draft after a %s and a failing list creates on first send", async (gone) => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await goneThenFailedList(gone, routes);
    routes["POST /conversations"] = { status: 201, body: conversation({ id: "n1", title: null, revision: 0 }) };
    routes["POST /chat"] = { status: 200, body: { turnId: "t9" } };
    routes["GET /conversations/n1"] = { status: 200, body: conversation({ id: "n1", title: null, revision: 0 }) };

    act(() => result.current.send("hello"));

    await until(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    expect(count(fetchMock, "POST /conversations")).toBe(1);
    const [, chat] = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")!;
    expect(JSON.parse(String(chat?.body))).toEqual({ conversationId: "n1", message: "hello" });
    expect(loadConversationId("ws")).toBe("n1");

    const listed = count(fetchMock, "GET /conversations?limit=1");
    await tick();
    await until(() => expect(count(fetchMock, "GET /conversations/n1")).toBeGreaterThan(0));
    await tick();
    expect(count(fetchMock, "GET /conversations?limit=1")).toBe(listed);
  });

  it("a retry after a 410 and a failing list opens the most recent with the notice alone", async () => {
    const routes: Record<string, Answer> = {};
    const { result } = await goneThenFailedList(410, routes);
    routes["GET /conversations"] = { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } };
    routes["GET /conversations/c2/records"] = { status: 200, body: { turns: [], next: null } };

    await tick();

    await until(() => expect(result.current.conversation?.id).toBe("c2"));
    expect(result.current.error).toBe(GONE[410].notice);
  });

  it("a retry after a 410 and a failing list that finds nothing keeps the draft with the notice alone", async () => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await goneThenFailedList(410, routes);
    routes["GET /conversations"] = { status: 200, body: { conversations: [], next: null } };
    const listed = count(fetchMock, "GET /conversations?limit=1");

    await tick();

    await until(() => expect(count(fetchMock, "GET /conversations?limit=1")).toBeGreaterThan(listed));
    await until(() => expect(result.current.error).toBe(GONE[410].notice));
    expect(result.current.draft).toBe(true);
  });

  it("a retry that finds nothing leaves an error set since the failure shown", async () => {
    const routes: Record<string, Answer> = {};
    const { fetchMock, result } = await goneThenFailedList(410, routes);
    routes["POST /conversations"] = refused(500, "ERR_CREATE_FAILED");
    act(() => result.current.send("hello"));
    const unrelated = "refused: ERR_CREATE_FAILED (ERR_CREATE_FAILED)";
    await until(() => expect(result.current.error).toBe(unrelated));
    routes["GET /conversations"] = { status: 200, body: { conversations: [], next: null } };
    const listed = count(fetchMock, "GET /conversations?limit=1");

    await tick();

    await until(() => expect(count(fetchMock, "GET /conversations?limit=1")).toBeGreaterThan(listed));
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.error).toBe(unrelated);
    expect(result.current.draft).toBe(true);
  });

  it("Branch from the unresolved conversation adopts the branch", async () => {
    const routes: Record<string, Answer> = {
      [`POST /conversations/${CONVERSATION}/branch`]: { status: 201, body: conversation({ id: "b1" }) },
      "GET /conversations/b1": { status: 200, body: conversation({ id: "b1" }) },
      "GET /conversations/b1/records": { status: 200, body: { turns: [finishedTurn("x1", "hi")], next: null } },
    };
    const { fetchMock, result } = await unresolved(routes);

    await act(() => result.current.branchFrom("t1"));

    await until(() => expect(result.current.conversation?.id).toBe("b1"));
    expect(loadConversationId("ws")).toBe("b1");
    expect(result.current.error).toBeNull();
    const oldAsked = count(fetchMock, pointed);
    await tick();
    await until(() => expect(count(fetchMock, "GET /conversations/b1")).toBeGreaterThan(0));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(count(fetchMock, pointed)).toBe(oldAsked);
  });

  it("Branch succeeding while a resolution is in flight is not switched back", async () => {
    const routes: Record<string, Answer> = {
      [`POST /conversations/${CONVERSATION}/branch`]: { status: 201, body: conversation({ id: "b1" }) },
      "GET /conversations/b1": { status: 200, body: conversation({ id: "b1" }) },
      "GET /conversations/b1/records": { status: 200, body: { turns: [finishedTurn("x1", "hi")], next: null } },
    };
    const { fetchMock, result } = await unresolved(routes);
    let answer!: (a: Answer) => void;
    routes[pointed] = { wait: new Promise((resolve) => (answer = resolve)) };
    const asked = count(fetchMock, pointed);
    await tick();
    await until(() => expect(count(fetchMock, pointed)).toBe(asked + 1));

    await act(() => result.current.branchFrom("t1"));
    await until(() => expect(result.current.conversation?.id).toBe("b1"));
    await act(async () => answer({ status: 200, body: conversation() }));
    await act(() => vi.advanceTimersByTimeAsync(250));

    expect(result.current.conversationId).toBe("b1");
    expect(result.current.conversation?.id).toBe("b1");
    expect(loadConversationId("ws")).toBe("b1");
  });

  it("Branch answered 410 leaves for the most recent conversation with the notice", async () => {
    const routes: Record<string, Answer> = {
      [`POST /conversations/${CONVERSATION}/branch`]: refused(410, "ERR_CONVERSATION_REMOVED"),
      "GET /conversations/c2/records": { status: 200, body: { turns: [], next: null } },
    };
    const { result } = await unresolved(routes);
    routes[pointed] = refused(410, "ERR_CONVERSATION_REMOVED");
    routes["GET /conversations"] = { status: 200, body: { conversations: [conversation({ id: "c2" })], next: null } };

    await act(() => result.current.branchFrom("t1"));

    await until(() => expect(result.current.conversation?.id).toBe("c2"));
    expect(result.current.error).toBe(GONE[410].notice);
    expect(loadConversationId("ws")).toBe("c2");
  });

  it("opening another conversation from the switcher while a resolution is in flight is not switched back", async () => {
    const routes: Record<string, Answer> = {
      "GET /conversations/c2/records": { status: 200, body: { turns: [finishedTurn("x1", "hi")], next: null } },
    };
    const { fetchMock, result } = await unresolved(routes);
    let answer!: (a: Answer) => void;
    routes[pointed] = { wait: new Promise((resolve) => (answer = resolve)) };
    const asked = count(fetchMock, pointed);
    await tick();
    await until(() => expect(count(fetchMock, pointed)).toBe(asked + 1));

    act(() => result.current.openConversation(conversation({ id: "c2" })));
    await until(() => expect(result.current.messages).toHaveLength(2));
    await act(async () => answer(failure));
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(result.current.conversationId).toBe("c2");
    expect(result.current.conversation?.id).toBe("c2");
    expect(loadConversationId("ws")).toBe("c2");
  });
});

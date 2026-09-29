import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import { AgentProvider, useAgent } from "@/agent";
import type { RecordsPage } from "@/agent/records";
import {
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  finishedTurn,
  installAgentGlobals,
  refused,
  requestsMade,
  stubAgent,
  type Answer,
} from "@/agent/__tests__/agent-harness";
import { AgentPanel } from "./AgentPanel";

// jsdom has no layout: the transcript's stick-to-bottom observer has nothing to observe.
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  installAgentGlobals();
  vi.stubGlobal("ResizeObserver", NoResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Workspace() {
  const { registerWorkspace, setConversation } = useAgent();
  useEffect(() => {
    registerWorkspace(fakeWorkspaceBridge);
    setConversation("ws");
  }, [registerWorkspace, setConversation]);
  return <AgentPanel />;
}

const renderPanel = () =>
  render(
    <AgentProvider>
      <Workspace />
    </AgentProvider>,
  );

const conversationRoute = `GET /conversations/${CONVERSATION}`;
const truncateRoute = `DELETE /conversations/${CONVERSATION}/turns`;

function twoTurns(): RecordsPage {
  return { turns: [finishedTurn("t1", "first"), finishedTurn("t2", "second")], next: null };
}

describe("AgentPanel with an agent serving conversations", () => {
  it("Delete from here names the turns it removes, and asks again with the new count after a 409", async () => {
    const page = twoTurns();
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
      [truncateRoute]: refused(409, "ERR_CONVERSATION_CHANGED", { revision: 5 }),
    };
    const fetchMock = stubAgent(page, routes);
    renderPanel();
    await screen.findByText("second");

    await userEvent.click((await screen.findAllByRole("button", { name: "Delete from here" }))[0]);
    expect(await screen.findByText("Delete 2 turns?")).toBeTruthy();

    page.turns.push(finishedTurn("t3", "third"));
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 5 }) };
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Delete 3 turns?")).toBeTruthy();
    routes[truncateRoute] = { status: 200, body: { removedTurns: 3, conversation: conversation({ revision: 6 }) } };
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("first")).toBeNull());
    expect(requestsMade(fetchMock).filter((r) => r.startsWith("DELETE"))).toEqual([
      `${truncateRoute}?from=t1&revision=3`,
      `${truncateRoute}?from=t1&revision=5`,
    ]);
  });

  it("Retry asks only when turns after the one it replaces would go", async () => {
    const fetchMock = stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
      [truncateRoute]: { status: 200, body: { removedTurns: 1, conversation: conversation({ revision: 4 }) } },
      "POST /chat": { status: 200, body: { turnId: "t3" } },
    });
    renderPanel();
    await screen.findByText("second");
    const [retryFirst, retryLast] = await screen.findAllByRole("button", { name: "Retry" });

    await userEvent.click(retryFirst);
    expect(await screen.findByText("Remove 1 turn after this one?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requestsMade(fetchMock).some((r) => r.startsWith("DELETE"))).toBe(false);

    await userEvent.click(retryLast);

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requestsMade(fetchMock)).toContain(`${truncateRoute}?from=t2&revision=3`);
  });

  it("after a 409, asks again only by the rule: a Retry with no later turn left runs without a dialog", async () => {
    const page = twoTurns();
    let truncations = 0;
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
      "POST /chat": { status: 200, body: { turnId: "t3" } },
    };
    Object.defineProperty(routes, truncateRoute, {
      enumerable: true,
      get: (): Answer =>
        truncations++ === 0
          ? refused(409, "ERR_CONVERSATION_CHANGED", { revision: 5 })
          : { status: 200, body: { removedTurns: 1, conversation: conversation({ revision: 6 }) } },
    });
    const fetchMock = stubAgent(page, routes);
    renderPanel();
    await screen.findByText("second");

    await userEvent.click((await screen.findAllByRole("button", { name: "Retry" }))[0]);
    expect(await screen.findByText("Remove 1 turn after this one?")).toBeTruthy();
    // Another client removed the later turn meanwhile.
    page.turns.pop();
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 5 }) };
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const made = requestsMade(fetchMock);
    expect(made.filter((r) => r.startsWith("DELETE"))).toEqual([
      `${truncateRoute}?from=t1&revision=3`,
      `${truncateRoute}?from=t1&revision=5`,
    ]);
    expect(made.indexOf(`${truncateRoute}?from=t1&revision=5`)).toBeLessThan(made.indexOf("POST /chat"));
  });

  it.each([
    ["its transcript", `GET /conversations/${CONVERSATION}/records`],
    ["its state", conversationRoute],
  ])("after a 409, a re-read failing at %s repeats nothing", async (_, failing) => {
    const page = twoTurns();
    page.turns.pop();
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
      [truncateRoute]: refused(409, "ERR_CONVERSATION_CHANGED", { revision: 5 }),
    };
    const fetchMock = stubAgent(page, routes);
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    // Another client added a turn; the re-read that would show it fails.
    routes[failing] = refused(500, "ERR_EXECUTION_FAILED");

    await userEvent.click(retry);

    expect(await screen.findByText(/ERR_EXECUTION_FAILED|re-read/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requestsMade(fetchMock).filter((r) => r.startsWith("DELETE"))).toEqual([`${truncateRoute}?from=t1&revision=3`]);
    expect(requestsMade(fetchMock)).not.toContain("POST /chat");
  });

  it("Edit & resend removes the turn, then sends the edited text under a fresh key", async () => {
    const fetchMock = stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
      [truncateRoute]: { status: 200, body: { removedTurns: 1, conversation: conversation({ revision: 4 }) } },
      "POST /chat": { status: 200, body: { turnId: "t3" } },
    });
    renderPanel();
    await screen.findByText("second");

    await userEvent.click((await screen.findAllByRole("button", { name: "Edit & resend" }))[1]);
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "second, edited{Enter}");

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const made = requestsMade(fetchMock);
    expect(made.indexOf(`${truncateRoute}?from=t2&revision=3`)).toBeGreaterThan(-1);
    expect(made.indexOf(`${truncateRoute}?from=t2&revision=3`)).toBeLessThan(made.indexOf("POST /chat"));
    const [, chat] = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")!;
    expect(JSON.parse(String(chat?.body))).toEqual({ conversationId: CONVERSATION, message: "second, edited" });
    expect((chat?.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("locks the composer of an archived conversation", async () => {
    stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation({ archived: true }) },
    });
    renderPanel();

    const composer = await screen.findByPlaceholderText("Archived — unarchive to continue");
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("names the conversation in the header as soon as its title is journaled", async () => {
    const running = finishedTurn("t1", "build a server");
    stubAgent(
      { turns: [{ ...running, status: "running", records: running.records.slice(0, 1) }], next: null },
      {
        "GET /capabilities": capabilities(),
        [conversationRoute]: { status: 200, body: conversation({ title: null }) },
      },
    );
    renderPanel();
    await screen.findByRole("button", { name: /Untitled/ });
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));

    act(() =>
      FakeEventStream.opened[0].emit({ id: 2, data: { type: "conversation-title", title: "HTTP server", model: "m" } }),
    );

    expect(await screen.findByRole("button", { name: /HTTP server/ })).toBeTruthy();
  });

  it("changes nothing for a title record carrying neither a title nor an error", async () => {
    const running = finishedTurn("t1", "build a server");
    stubAgent(
      { turns: [{ ...running, status: "running", records: running.records.slice(0, 1) }], next: null },
      {
        "GET /capabilities": capabilities(),
        [conversationRoute]: { status: 200, body: conversation({ title: null }) },
      },
    );
    renderPanel();
    await screen.findByRole("button", { name: /Untitled/ });
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));

    act(() => {
      FakeEventStream.opened[0].emit({ id: 2, data: { type: "conversation-title", model: "m", usage: { totalTokens: 3 } } });
      FakeEventStream.opened[0].emit({ id: 3, data: { type: "text-delta", delta: "Working" } });
    });

    await screen.findByText("Working");
    expect(screen.getByRole("button", { name: /Untitled/ })).toBeTruthy();
    expect(screen.queryByText(/Couldn't name this conversation/)).toBeNull();
  });

  it("shows a summary after the last turn it covers, expandable to the summary", async () => {
    const host = finishedTurn("t3", "third");
    host.records.splice(1, 0, {
      id: 9,
      data: { type: "context-summary", throughTurnId: "t1", summary: "The user asked for a server.", model: "m" },
    });
    stubAgent(
      { turns: [finishedTurn("t1", "first", "reply one"), finishedTurn("t2", "second"), host], next: null },
      { "GET /capabilities": capabilities(), [conversationRoute]: { status: 200, body: conversation() } },
    );
    renderPanel();

    const divider = await screen.findByText("Earlier turns were summarized for the agent");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("reply one")).toBeLessThan(text.indexOf("Earlier turns were summarized"));
    expect(text.indexOf("Earlier turns were summarized")).toBeLessThan(text.indexOf("second"));
    expect(screen.queryByText("The user asked for a server.")).toBeNull();

    await userEvent.click(divider);

    expect(screen.getByText("The user asked for a server.")).toBeTruthy();
  });
});

describe("the conversation switcher", () => {
  it("lists, searches by q and loads more", async () => {
    const fetchMock = stubAgent(twoTurns(), {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation() },
      "GET /conversations": {
        status: 200,
        body: {
          conversations: [conversation(), conversation({ id: "c2", title: null })],
          next: { before: "2026-09-27T00:00:00.000Z", beforeId: "c2" },
        },
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /Build a server/ }));
    const list = await screen.findByRole("list", { name: "Conversations" });
    await waitFor(() => expect(within(list).getByText("Untitled")).toBeTruthy());

    await userEvent.type(screen.getByRole("textbox", { name: "Search conversations" }), "server");
    await waitFor(() => expect(requestsMade(fetchMock).some((r) => r.includes("q=server"))).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(requestsMade(fetchMock).some((r) => r.includes("before=2026-09-27T00%3A00%3A00.000Z&beforeId=c2"))).toBe(
        true,
      ),
    );
  });

  it("renames, archives, and deletes after a confirmation naming the conversation", async () => {
    const routes: Record<string, Answer> = {
      "GET /capabilities": capabilities(),
      [conversationRoute]: { status: 200, body: conversation() },
      "GET /conversations": {
        status: 200,
        body: { conversations: [conversation(), conversation({ id: "c2", title: "Old idea" })], next: null },
      },
      "PATCH /conversations/c2": { status: 200, body: conversation({ id: "c2", title: "Better idea" }) },
      "DELETE /conversations/c2": { status: 204, body: null },
    };
    const fetchMock = stubAgent(twoTurns(), routes);
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /Build a server/ }));
    const menu = async () =>
      userEvent.click(await screen.findByRole("button", { name: "Actions for Old idea" }));

    await menu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const title = await screen.findByRole("textbox", { name: "Conversation title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Better idea{Enter}");

    await menu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    await menu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Delete “Old idea”?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("DELETE /conversations/c2"));
    const patches = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patches).toEqual([{ title: "Better idea" }, { archived: true }]);
  });
});

describe("AgentPanel with an agent that predates conversations", () => {
  it("shows no switcher, and only Copy on hover", async () => {
    const fetchMock = stubAgent(twoTurns(), { "GET /capabilities": capabilities({ features: undefined }) });
    renderPanel();
    await screen.findByText("second");
    await waitFor(() => expect(requestsMade(fetchMock)).toContain("GET /capabilities"));

    expect(screen.getByText("Authoring agent")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(4);
    for (const name of ["Retry", "Branch", "Edit & resend", "Delete from here"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

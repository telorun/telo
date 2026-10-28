import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import { AgentProvider, STARTER_PROMPTS, useAgent } from "@/agent";
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

describe("AgentPanel with an agent that does not answer its capabilities", () => {
  it("shows the failure in the panel, not only in the settings", async () => {
    stubAgent(twoTurns(), { "GET /capabilities": { status: 502, body: {} } });
    renderPanel();
    expect(await screen.findByText("The agent is not answering: GET /capabilities failed (502)")).toBeTruthy();
  });
});

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

describe("the composer", () => {
  const composer = () => screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message the agent" });
  const runningTurn = (): RecordsPage => {
    const turn = finishedTurn("t1", "build it");
    return { turns: [{ ...turn, status: "running", records: turn.records.slice(0, 2) }], next: null };
  };

  it("sends on Cmd/Ctrl+Enter, and says so on its button", async () => {
    const fetchMock = stubAgent(twoTurns(), { "POST /chat": { status: 200, body: { turnId: "t3" } } });
    renderPanel();
    await screen.findByText("second");
    expect(screen.getByRole("button", { name: "Send" }).title).toMatch(/Enter or (Ctrl\+|⌘)Enter/);

    await userEvent.type(await composer(), "add a route{Control>}{Enter}{/Control}");

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    expect((await composer()).value).toBe("");
  });

  it("stays usable while a turn runs: Enter queues, Edit brings the queued message back, Esc stops the turn", async () => {
    const fetchMock = stubAgent(runningTurn(), { "POST /chat/t1/abort": { status: 200, body: { cancelled: true } } });
    renderPanel();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect((await composer()).disabled).toBe(false);

    await userEvent.type(await composer(), "then add tests{Enter}");

    const queued = await screen.findByRole("group", { name: "Queued message" });
    expect(within(queued).getByText("then add tests")).toBeTruthy();
    expect(requestsMade(fetchMock)).not.toContain("POST /chat");

    await userEvent.click(within(queued).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("group", { name: "Queued message" })).toBeNull();
    expect((await composer()).value).toBe("then add tests");

    await userEvent.type(await composer(), "{Escape}");
    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat/t1/abort"));
  });

  it("an empty conversation offers starter prompts and the agent's own capabilities; a starter fills the composer", async () => {
    const fetchMock = stubAgent(
      { turns: [], next: null },
      {
        "GET /capabilities": capabilities({ auth: "none" }),
        [conversationRoute]: { status: 200, body: conversation() },
      },
    );
    renderPanel();

    expect(
      await screen.findByText("This agent can run manifests and their tests, and accepts requests without a token."),
    ).toBeTruthy();
    await userEvent.type(await composer(), "half a thought");
    await userEvent.click(await screen.findByRole("button", { name: STARTER_PROMPTS[1].label }));

    expect((await composer()).value).toBe(STARTER_PROMPTS[1].prompt);
    expect(requestsMade(fetchMock)).not.toContain("POST /chat");
  });
});

describe("attachments in the panel", () => {
  const limits = { maxBytes: 1048576, maxPerMessage: 10, mediaTypes: ["image/png", "application/yaml", "text/*"] };
  const serving = (): Record<string, Answer> => ({
    "GET /capabilities": capabilities({
      features: ["conversations", "conversation-truncation", "attachments"],
      attachments: limits,
    }),
    [conversationRoute]: { status: 200, body: conversation({ revision: 3 }) },
    [`POST /conversations/${CONVERSATION}/attachments`]: {
      status: 201,
      body: { id: "a9", name: "notes.txt", mediaType: "text/plain", size: 5 },
    },
  });
  const notes = () => new File(["hello"], "notes.txt", { type: "text/plain" });
  const chips = () => screen.findByRole("list", { name: "Attached files" });

  it("takes a picked, a pasted and a dropped file as chips with name and size, and Remove drops one", async () => {
    stubAgent(twoTurns(), serving());
    renderPanel();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Attach files" }).disabled).toBe(false));

    await userEvent.upload(screen.getByLabelText("Files to attach"), notes());
    await waitFor(async () => expect(within(await chips()).getByText("5 B")).toBeTruthy());
    expect(within(await chips()).getByText("notes.txt")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message the agent" });
    fireEvent.paste(composer, { clipboardData: { files: [notes()] } });
    await waitFor(async () => expect(within(await chips()).getAllByRole("listitem")).toHaveLength(2));

    const transfer = { types: ["Files"], files: [notes()] };
    fireEvent.dragEnter(composer, { dataTransfer: transfer });
    expect(screen.getByRole("status").textContent).toBe("Drop files to attach");
    fireEvent.drop(composer, { dataTransfer: transfer });
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(async () => expect(within(await chips()).getAllByRole("listitem")).toHaveLength(3));

    await userEvent.click(within(await chips()).getAllByRole("button", { name: "Remove notes.txt" })[0]);
    expect(within(await chips()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows a message's attachments from its record, and Retry sends their ids again", async () => {
    const page = twoTurns();
    (page.turns[1].records[0].data as { attachments?: unknown }).attachments = [
      { id: "a1", name: "telo.yaml", mediaType: "application/yaml", size: 23, sha256: "ab" },
    ];
    const fetchMock = stubAgent(page, {
      ...serving(),
      [truncateRoute]: { status: 200, body: { removedTurns: 1, conversation: conversation({ revision: 4 }) } },
      "POST /chat": { status: 200, body: { turnId: "t3" } },
    });
    renderPanel();

    const listed = await screen.findByRole("list", { name: "Attachments" });
    expect(within(listed).getByText("telo.yaml · 23 B")).toBeTruthy();

    await userEvent.click((await screen.findAllByRole("button", { name: "Retry" }))[1]);

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    const [, chat] = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")!;
    expect(JSON.parse(String(chat?.body))).toEqual({ conversationId: CONVERSATION, message: "second", attachments: ["a1"] });
  });

  it("shows the attach button disabled, with the reason, without the feature", async () => {
    stubAgent(twoTurns(), { "GET /capabilities": capabilities(), [conversationRoute]: { status: 200, body: conversation() } });
    renderPanel();
    await screen.findByText("second");
    await screen.findByRole("button", { name: /Build a server/ });

    const attach = screen.getByRole<HTMLButtonElement>("button", { name: "Attach files" });
    expect([attach.disabled, attach.title]).toEqual([true, "This agent does not accept file attachments"]);
    const composer = screen.getByRole("textbox", { name: "Message the agent" });
    fireEvent.dragEnter(composer, { dataTransfer: { types: ["Files"], files: [notes()] } });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

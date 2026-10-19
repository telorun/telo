import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";

import type { RecordsPage } from "../records";
import type { JournalRecord } from "../types";
import {
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  finishedTurn,
  installAgentGlobals,
  openAgent,
  openConversations,
  requestsMade,
  stubAgent,
} from "./agent-harness";

const running: JournalRecord[] = [
  { id: 1, data: { type: "user-message", content: "build it", model: "m" } },
  { id: 2, data: { type: "text-delta", delta: "Working" } },
];
const runningPage = (): RecordsPage => ({
  turns: [{ turnId: "t1", status: "running", error: null, records: running }],
  next: null,
});
const finishedPage = (): RecordsPage => ({ turns: [finishedTurn("t1", "first")], next: null });
const startsTurn = { "POST /chat": { status: 200, body: { turnId: "t2" } } };

/** The messages `POST /chat` was asked to start a turn with, in order. */
function turnsStarted(fetchMock: ReturnType<typeof stubAgent>): string[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")
    .map(([, init]) => (JSON.parse(String(init?.body)) as { message: string }).message);
}

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the composer's text", () => {
  it("is still there after the provider is mounted again, and is cleared by sending it", async () => {
    const fetchMock = stubAgent(finishedPage(), startsTurn);
    const first = await openAgent();
    act(() => first.result.current.setComposerText("half a thought"));
    first.unmount();

    const { result } = await openAgent();
    expect(result.current.composer.text).toBe("half a thought");

    act(() => result.current.submitComposer());

    expect(result.current.composer.text).toBe("");
    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual(["half a thought"]));
  });

  it("is kept per conversation", async () => {
    stubAgent(finishedPage(), {
      "GET /capabilities": capabilities(),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
      "GET /conversations/c2/records": { status: 200, body: { turns: [], next: null } },
    });
    const { result } = await openConversations();
    act(() => result.current.setComposerText("for the first"));

    act(() => result.current.openConversation(conversation({ id: "c2" })));
    expect(result.current.composer.text).toBe("");
    act(() => result.current.setComposerText("for the second"));

    act(() => result.current.openConversation(conversation()));
    expect(result.current.composer.text).toBe("for the first");
    act(() => result.current.openConversation(conversation({ id: "c2" })));
    expect(result.current.composer.text).toBe("for the second");
  });

  it("takes prepared text after what is there, opens the panel, and sends nothing", async () => {
    const fetchMock = stubAgent(finishedPage(), startsTurn);
    const { result } = await openAgent();
    act(() => result.current.togglePanel());
    expect(result.current.panelOpen).toBe(false);
    act(() => result.current.setComposerText("While you are at it"));

    act(() => result.current.compose("Fix this diagnostic: X"));

    expect(result.current.composer.text).toBe("While you are at it\n\nFix this diagnostic: X");
    expect(result.current.panelOpen).toBe(true);
    expect(turnsStarted(fetchMock)).toEqual([]);
  });
});

describe("an editor selection", () => {
  const selected = { file: "telo.yaml", startLine: 3, endLine: 4, text: "kind: Http.Server\nport: 80" };
  const carried = "why?\n\n```telo-selection telo.yaml:3-4\nkind: Http.Server\nport: 80\n```";

  it("goes with the next message, and not with the one after it", async () => {
    const fetchMock = stubAgent(finishedPage(), startsTurn);
    const { result } = await openAgent();
    act(() => result.current.setEditorSelection("source:telo.yaml", selected));
    act(() => result.current.setComposerText("why?"));

    act(() => result.current.submitComposer());

    expect(result.current.editorSelection).toBeNull();
    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual([carried]));
  });

  it("is left out once removed, and is no message on its own", async () => {
    const fetchMock = stubAgent(finishedPage(), startsTurn);
    const { result } = await openAgent();
    act(() => result.current.setEditorSelection("source:telo.yaml", selected));
    act(() => result.current.submitComposer());
    expect(result.current.editorSelection).toEqual(selected);

    act(() => result.current.dropSelection());
    act(() => result.current.setComposerText("why?"));
    act(() => result.current.submitComposer());

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual(["why?"]));
  });

  it("is dropped only by the editor that reported it", async () => {
    stubAgent(finishedPage(), startsTurn);
    const { result } = await openAgent();
    act(() => result.current.setEditorSelection("source:telo.yaml", selected));

    act(() => result.current.setEditorSelection("detail-yaml", null));
    expect(result.current.editorSelection).toEqual(selected);

    act(() => result.current.setEditorSelection("source:telo.yaml", null));
    expect(result.current.editorSelection).toBeNull();
  });

  async function queueWithSelection() {
    const fetchMock = stubAgent(runningPage(), startsTurn);
    const view = await openAgent();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    act(() => view.result.current.setEditorSelection("source:telo.yaml", selected));
    act(() => view.result.current.setComposerText("why?"));
    act(() => view.result.current.submitComposer());
    return { fetchMock, ...view };
  }

  it("is queued with a message submitted while a turn runs, and sent with it when the turn finishes", async () => {
    const { fetchMock, result } = await queueWithSelection();
    expect(result.current.composer.queued).toEqual({ text: "why?", attachments: [], selections: [selected] });
    expect(result.current.editorSelection).toBeNull();

    act(() => FakeEventStream.opened[0].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual([carried]));
  });

  it("comes back from the queue as a selection, not as text, and goes with the next message", async () => {
    const { fetchMock, result } = await queueWithSelection();

    act(() => result.current.editQueued());

    expect(result.current.composer).toEqual({ text: "why?", attachments: [], selections: [selected], queued: null });
    act(() => FakeEventStream.opened[0].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    act(() => result.current.submitComposer());
    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual([carried]));
    expect(result.current.composer.selections).toEqual([]);
  });

  it("is carried once when the live selection is the one the composer already holds", async () => {
    const { fetchMock, result } = await queueWithSelection();
    act(() => result.current.editQueued());
    act(() => result.current.setEditorSelection("source:telo.yaml", selected));
    act(() => FakeEventStream.opened[0].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    act(() => result.current.submitComposer());

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual([carried]));
  });

  it("is kept with the queued message across a reload", async () => {
    const { unmount } = await queueWithSelection();
    unmount();

    const { result } = await openAgent();

    expect(result.current.composer.queued).toEqual({ text: "why?", attachments: [], selections: [selected] });
  });
});

describe("a message submitted while a turn runs", () => {
  async function queueDuringTurn(page = runningPage(), routes = {}) {
    const fetchMock = stubAgent(page, { ...startsTurn, ...routes });
    const view = await openAgent();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    act(() => view.result.current.setComposerText("then add tests"));
    act(() => view.result.current.submitComposer());
    return { fetchMock, ...view };
  }

  it("is queued, a second one appended to it, and sent as a turn of its own when the turn finishes", async () => {
    const { fetchMock, result } = await queueDuringTurn();
    expect(result.current.composer).toEqual({ text: "", attachments: [], selections: [], queued: { text: "then add tests", attachments: [], selections: [] } });

    act(() => result.current.setComposerText("and docs"));
    act(() => result.current.submitComposer());
    expect(result.current.composer.queued).toEqual({ text: "then add tests\n\nand docs", attachments: [], selections: [] });
    expect(turnsStarted(fetchMock)).toEqual([]);

    act(() => FakeEventStream.opened[0].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual(["then add tests\n\nand docs"]));
    expect(result.current.composer).toEqual({ text: "", attachments: [], selections: [], queued: null });
    expect(result.current.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      "build it",
      "then add tests\n\nand docs",
    ]);
  });

  it("returns to the composer, unsent, when the turn is stopped", async () => {
    const { fetchMock, result } = await queueDuringTurn(runningPage(), {
      "POST /chat/t1/abort": { status: 200, body: { cancelled: true } },
    });

    act(() => result.current.stop());
    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat/t1/abort"));
    act(() => FakeEventStream.opened[0].fail("ERR_INVOKE_CANCELLED", "cancelled by caller"));

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.composer).toEqual({ text: "then add tests", attachments: [], selections: [], queued: null });
    expect(turnsStarted(fetchMock)).toEqual([]);
  });

  it("returns to the composer, unsent, when the turn fails", async () => {
    const { fetchMock, result } = await queueDuringTurn();

    act(() => FakeEventStream.opened[0].fail("ERR_PROVIDER_FAILED", "the model refused"));

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.composer).toEqual({ text: "then add tests", attachments: [], selections: [], queued: null });
    expect(turnsStarted(fetchMock)).toEqual([]);
  });

  it("is still queued after a reload under the same turn, and follows that turn's finish", async () => {
    const { fetchMock, unmount } = await queueDuringTurn();
    unmount();

    const { result } = await openAgent();
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(2));
    expect(result.current.composer.queued).toEqual({ text: "then add tests", attachments: [], selections: [] });

    act(() => FakeEventStream.opened[1].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual(["then add tests"]));
  });

  it("returns to the composer when a reload finds its turn already ended", async () => {
    const page = runningPage();
    const { fetchMock, unmount } = await queueDuringTurn(page);
    unmount();
    page.turns[0] = finishedTurn("t1", "build it");

    const { result } = await openAgent();

    await waitFor(() => expect(result.current.composer).toEqual({ text: "then add tests", attachments: [], selections: [], queued: null }));
    expect(turnsStarted(fetchMock)).toEqual([]);
  });
});

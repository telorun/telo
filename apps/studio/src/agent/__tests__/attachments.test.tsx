import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";

import type { RecordsPage } from "../records";
import { LOCAL_PREFIXES } from "../../storage-keys";
import {
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  fakeWorkspaceBridge,
  finishedTurn,
  installAgentGlobals,
  openConversations,
  refused,
  requestsMade,
  stubAgent,
  type Answer,
} from "./agent-harness";

const LIMITS = {
  maxBytes: 1024,
  maxPerMessage: 2,
  mediaTypes: ["image/png", "application/yaml", "text/*"],
};
const withAttachments = (): Answer =>
  capabilities({ features: ["conversations", "conversation-truncation", "attachments"], attachments: LIMITS });
const uploadRoute = `POST /conversations/${CONVERSATION}/attachments`;
const uploaded = (id: string, name: string, mediaType: string, size: number): Answer => ({
  status: 201,
  body: { id, name, mediaType, size },
});
const finishedPage = (): RecordsPage => ({ turns: [finishedTurn("t1", "first")], next: null });

function routes(over: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    "GET /capabilities": withAttachments(),
    [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
    "POST /chat": { status: 200, body: { turnId: "t2" } },
    ...over,
  };
}

/** What each `POST /chat` was asked to start a turn with. */
function turnsStarted(fetchMock: ReturnType<typeof stubAgent>) {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/chat") && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as { conversationId: string; message: string; attachments?: string[] });
}

/** The `file` part of each upload, in order. */
function partsUploaded(fetchMock: ReturnType<typeof stubAgent>): File[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/attachments") && init?.method === "POST")
    .map(([, init]) => (init?.body as FormData).get("file") as File);
}

async function openWithAttachments(page: RecordsPage, over: Record<string, Answer> = {}) {
  const fetchMock = stubAgent(page, routes(over));
  const view = await openConversations();
  await waitFor(() => expect(view.result.current.attachmentLimits).toEqual(LIMITS));
  return { fetchMock, ...view };
}

const manifest = () => new File(["kind: Telo.Application\n"], "telo.yaml", { type: "" });

beforeEach(installAgentGlobals);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("a file added to the composer", () => {
  it("is uploaded at once under the type its extension names, and goes with the message by id", async () => {
    const { fetchMock, result } = await openWithAttachments(finishedPage(), {
      [uploadRoute]: uploaded("a1", "telo.yaml", "application/yaml", 23),
    });

    act(() => result.current.addAttachments([manifest()]));

    await waitFor(() =>
      expect(result.current.composer.attachments).toMatchObject([{ state: "uploaded", id: "a1", name: "telo.yaml" }]),
    );
    const [part] = partsUploaded(fetchMock);
    expect([part.name, part.type]).toEqual(["telo.yaml", "application/yaml"]);
    expect(turnsStarted(fetchMock)).toEqual([]);

    act(() => result.current.submitComposer());

    await waitFor(() =>
      expect(turnsStarted(fetchMock)).toEqual([{ conversationId: CONVERSATION, message: "", attachments: ["a1"] }]),
    );
    expect(result.current.composer.attachments).toEqual([]);
    expect(result.current.messages.filter((m) => m.role === "user").at(-1)).toMatchObject({
      attachments: [{ id: "a1", name: "telo.yaml", mediaType: "application/yaml", size: 23 }],
    });
  });

  it("is refused before any upload when the capability document rules it out, naming the limit", async () => {
    const { fetchMock, result } = await openWithAttachments(finishedPage(), {
      [uploadRoute]: uploaded("a1", "a.txt", "text/plain", 1),
    });

    act(() =>
      result.current.addAttachments([
        new File([new Uint8Array(2048)], "big.png", { type: "image/png" }),
        new File(["x"], "clip.mov", { type: "video/quicktime" }),
      ]),
    );

    expect(result.current.composer.attachments).toMatchObject([
      { state: "failed", reason: "Larger than the 1 KB limit." },
      { state: "failed", reason: "video/quicktime files are not accepted. Accepted: image/png, application/yaml, text/*." },
    ]);

    act(() =>
      result.current.addAttachments(["a.txt", "b.txt", "c.txt"].map((name) => new File(["x"], name, { type: "text/plain" }))),
    );

    expect(result.current.composer.attachments[4]).toMatchObject({
      name: "c.txt",
      state: "failed",
      reason: "A message takes at most 2 files.",
    });
    await waitFor(() => expect(partsUploaded(fetchMock).map((part) => part.name)).toEqual(["a.txt", "b.txt"]));
  });

  it("shows the agent's refusal in words and holds the send until the file is removed", async () => {
    const { fetchMock, result } = await openWithAttachments(finishedPage(), {
      [uploadRoute]: refused(415, "ERR_ATTACHMENT_MISLABELLED", { mediaType: "application/zip" }),
    });
    act(() => result.current.setComposerText("look at this"));

    act(() => result.current.addAttachments([new File(["PK"], "shot.png", { type: "image/png" })]));

    await waitFor(() =>
      expect(result.current.composer.attachments).toMatchObject([
        { state: "failed", reason: "Its content is application/zip, which does not match its type." },
      ]),
    );
    act(() => result.current.submitComposer());
    expect(turnsStarted(fetchMock)).toEqual([]);

    act(() => result.current.removeAttachment(result.current.composer.attachments[0].key));
    act(() => result.current.submitComposer());

    await waitFor(() => expect(turnsStarted(fetchMock)).toEqual([{ conversationId: CONVERSATION, message: "look at this" }]));
  });

  it("holds the send while it is still uploading", async () => {
    let arrive!: (answer: Answer) => void;
    const { fetchMock, result } = await openWithAttachments(finishedPage(), {
      [uploadRoute]: { wait: new Promise<Answer>((resolve) => (arrive = resolve)) },
    });
    act(() => result.current.setComposerText("see attached"));
    act(() => result.current.addAttachments([manifest()]));
    await waitFor(() => expect(partsUploaded(fetchMock)).toHaveLength(1));

    act(() => result.current.submitComposer());
    expect(result.current.composer.text).toBe("see attached");
    expect(turnsStarted(fetchMock)).toEqual([]);

    await act(async () => arrive(uploaded("a1", "telo.yaml", "application/yaml", 23)));
    await waitFor(() => expect(result.current.composer.attachments[0].state).toBe("uploaded"));
    act(() => result.current.submitComposer());

    await waitFor(() => expect(turnsStarted(fetchMock)[0]).toMatchObject({ message: "see attached", attachments: ["a1"] }));
  });

  it("creates a draft's conversation first, and the send that follows reuses it", async () => {
    localStorage.removeItem(LOCAL_PREFIXES.agentConv + "ws");
    const fetchMock = stubAgent(
      { turns: [], next: null },
      routes({
        "GET /conversations": { status: 200, body: { conversations: [], next: null } },
        "POST /conversations": { status: 201, body: conversation() },
        [uploadRoute]: uploaded("a1", "telo.yaml", "application/yaml", 23),
      }),
    );
    const { result } = await openConversationsDraft();

    act(() => result.current.addAttachments([manifest(), new File(["x"], "notes.txt", { type: "text/plain" })]));

    await waitFor(() => expect(result.current.composer.attachments.every((a) => a.state === "uploaded")).toBe(true));
    expect(result.current.conversationId).toBe(CONVERSATION);
    act(() => result.current.submitComposer());

    await waitFor(() => expect(turnsStarted(fetchMock)[0]).toMatchObject({ conversationId: CONVERSATION }));
    expect(requestsMade(fetchMock).filter((r) => r === "POST /conversations")).toHaveLength(1);
  });

  it("is kept across a reload by its descriptor once uploaded, and dropped when it was still uploading", async () => {
    const { result, unmount } = await openWithAttachments(finishedPage(), {
      [uploadRoute]: uploaded("a1", "telo.yaml", "application/yaml", 23),
    });
    act(() => result.current.addAttachments([manifest()]));
    await waitFor(() => expect(result.current.composer.attachments[0].state).toBe("uploaded"));
    unmount();

    const pending = await openWithAttachments(finishedPage(), { [uploadRoute]: { wait: new Promise<Answer>(() => undefined) } });
    expect(pending.result.current.composer.attachments).toEqual([
      { key: "a1", state: "uploaded", id: "a1", name: "telo.yaml", mediaType: "application/yaml", size: 23 },
    ]);
    act(() => pending.result.current.addAttachments([new File(["x"], "notes.txt", { type: "text/plain" })]));
    expect(pending.result.current.composer.attachments).toHaveLength(2);
    pending.unmount();

    const reloaded = await openWithAttachments(finishedPage());
    expect(reloaded.result.current.composer.attachments.map((a) => a.name)).toEqual(["telo.yaml"]);
  });

  it("is not taken by an agent whose features do not list attachments", async () => {
    const fetchMock = stubAgent(finishedPage(), routes({ "GET /capabilities": capabilities({ attachments: LIMITS }) }));
    const { result } = await openConversations();
    await waitFor(() => expect(result.current.features.conversations).toBe(true));

    act(() => result.current.addAttachments([manifest()]));

    expect(result.current.attachmentLimits).toBeNull();
    expect(result.current.composer.attachments).toEqual([]);
    expect(partsUploaded(fetchMock)).toEqual([]);
  });
});

describe("a queued message's files", () => {
  it("queue with its text, come back with it on Edit, and go out with it when the turn finishes", async () => {
    const running = finishedTurn("t1", "build it");
    const { fetchMock, result } = await openWithAttachments(
      { turns: [{ ...running, status: "running", records: running.records.slice(0, 2) }], next: null },
      { [uploadRoute]: uploaded("a1", "telo.yaml", "application/yaml", 23) },
    );
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    act(() => result.current.setComposerText("use this"));
    act(() => result.current.addAttachments([manifest()]));
    await waitFor(() => expect(result.current.composer.attachments[0].state).toBe("uploaded"));
    const file = { id: "a1", name: "telo.yaml", mediaType: "application/yaml", size: 23 };

    act(() => result.current.submitComposer());
    expect(result.current.composer).toEqual({ text: "", attachments: [], queued: { text: "use this", attachments: [file] } });

    act(() => result.current.editQueued());
    expect(result.current.composer).toMatchObject({ text: "use this", attachments: [{ ...file, state: "uploaded" }], queued: null });

    act(() => result.current.submitComposer());
    act(() => FakeEventStream.opened[0].emit({ id: 3, data: { type: "finish", finishReason: "stop" } }));

    await waitFor(() => expect(turnsStarted(fetchMock)[0]).toMatchObject({ message: "use this", attachments: ["a1"] }));
  });
});

/** The provider on an agent serving conversations, in a workspace with none. */
async function openConversationsDraft() {
  const view = renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
  act(() => {
    view.result.current.registerWorkspace(fakeWorkspaceBridge);
    view.result.current.setConversation("ws");
  });
  await waitFor(() => expect(view.result.current.attachmentLimits).toEqual(LIMITS));
  await waitFor(() => expect(view.result.current.draft).toBe(true));
  return view;
}

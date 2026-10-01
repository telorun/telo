import { afterEach, expect, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import { AGENT_PANEL_DEFAULT_WIDTH, saveAgentSettings, saveConversationId } from "../storage";
import type { Conversation, JournalRecord, TurnRecords, WorkspaceBridge } from "../types";

// A provider left mounted keeps its identity timer and revision poll running
// into the next test, or into a torn-down environment.
afterEach(() => cleanup());

/** The provider under test, on a dev-override agent, with a conversation open
 *  and a workspace registered, talking to a fetch stub that also serves the
 *  turns' event streams. */

export const AGENT_URL = "http://agent.test";
export const CONVERSATION = "conv-1";

/** One `GET /chat/{turnId}/events` connection the provider opened: its body is
 *  written by the test, frame by frame, as the agent would. */
export class FakeEventStream {
  static opened: FakeEventStream[] = [];
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly response: Response;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  /** Set when the client closed the connection. */
  closed = false;
  constructor(url: string, init: RequestInit | undefined) {
    this.url = url;
    this.headers = { ...(init?.headers as Record<string, string> | undefined) };
    init?.signal?.addEventListener("abort", () => {
      this.closed = true;
    });
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    FakeEventStream.opened.push(this);
  }
  private write(frame: string) {
    this.controller.enqueue(this.encoder.encode(frame));
  }
  emit(record: JournalRecord) {
    this.write(`id: ${record.id}\nevent: message\ndata: ${JSON.stringify({ data: record.data })}\n\n`);
  }
  /** A server-sent `event: error` frame. */
  fail(code: string, message: string) {
    this.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
    this.controller.close();
  }
}

/** A response; `reject`: the fetch itself fails, as it does off the network;
 *  `wait`: the response arrives when the test settles it. */
export type Answer =
  | { status: number; body: unknown }
  | { reject: string }
  | { wait: Promise<Answer> };

/** Answers every request the provider makes: the records page, the workspace
 *  tree (empty) and whatever `routes` names by "METHOD path". */
export function stubAgent(page: RecordsPage, routes: Record<string, Answer> = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    // Read once: a route may answer each request differently.
    const routed = routes[key];
    if (!routed && /^GET \/chat\/[^/]+\/events$/.test(key)) {
      return new FakeEventStream(String(input), init).response;
    }
    const answered: Answer =
      routed ??
      (key === `GET /conversations/${CONVERSATION}/records`
        ? { status: 200, body: page }
        : key === "GET /workspace"
          ? { status: 200, body: { files: [] } }
          : key === "GET /capabilities"
            ? { status: 404, body: { error: "not found" } }
            : { status: 599, body: { error: `unexpected ${key}` } });
    const answer = "wait" in answered ? await answered.wait : answered;
    if ("wait" in answer) throw new Error("a waited answer is itself a response or a rejection");
    if ("reject" in answer) throw new TypeError(answer.reject);
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** `GET /capabilities` of an agent serving every conversation surface. */
export function capabilities(over: Record<string, unknown> = {}): Answer {
  return {
    status: 200,
    body: {
      agent: { name: "AuthoringAgent", version: "0.10.0" },
      prompt: { id: "ab12" },
      auth: "bearer",
      features: ["conversations", "conversation-truncation", "conversation-branching"],
      manifestRuns: true,
      ...over,
    },
  };
}

/** A conversation as the agent reports it. */
export function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION,
    title: "Build a server",
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:05:00.000Z",
    model: "m",
    messageCount: 2,
    totalTokens: 120,
    archived: false,
    revision: 1,
    ...over,
  };
}

/** A finished turn asking `request` and answered `reply`. */
export function finishedTurn(turnId: string, request: string, reply = "Done."): TurnRecords {
  return {
    turnId,
    status: "finished",
    error: null,
    records: [
      { id: 1, data: { type: "user-message", content: request, model: "m" } },
      { id: 2, data: { type: "text-delta", delta: reply } },
      { id: 3, data: { type: "finish", finishReason: "stop" } },
    ],
  };
}

/** A refusal body as the agent writes one. */
export function refused(status: number, code: string, extra: Record<string, unknown> = {}): Answer {
  return { status, body: { code, error: `refused: ${code}`, ...extra } };
}

/** The requests the provider made, as "METHOD path?query", in order. */
export function requestsMade(fetchMock: ReturnType<typeof stubAgent>): string[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    return `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
  });
}

const bridge: WorkspaceBridge = {
  snapshot: async () => new Map(),
  readFile: async () => "",
  applyChanges: async () => undefined,
  editorFile: () => null,
};

export function installAgentGlobals() {
  FakeEventStream.opened = [];
  saveAgentSettings({ overrideUrl: AGENT_URL, panelOpen: true, panelWidth: AGENT_PANEL_DEFAULT_WIDTH, questionCards: true });
  saveConversationId("ws", CONVERSATION);
}

/** Render the provider on an agent serving conversations and open the
 *  workspace; resolves once the conversation named by `id` is open. */
export async function openConversations(id = CONVERSATION) {
  const view = renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
  act(() => {
    view.result.current.registerWorkspace(bridge);
    view.result.current.setConversation("ws");
  });
  await waitFor(() => expect(view.result.current.conversation?.id).toBe(id));
  return view;
}

export { bridge as fakeWorkspaceBridge };

/** Render the provider and open the conversation; resolves once its records
 *  were read. */
export async function openAgent() {
  const view = renderHook(() => useAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => <AgentProvider>{children}</AgentProvider>,
  });
  act(() => {
    view.result.current.registerWorkspace(bridge);
    view.result.current.setConversation("ws");
  });
  await waitFor(() => expect(view.result.current.messages.length).toBeGreaterThan(0));
  return view;
}

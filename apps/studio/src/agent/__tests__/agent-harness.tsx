import { expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import { AGENT_PANEL_DEFAULT_WIDTH, saveAgentSettings, saveConversationId } from "../storage";
import type { JournalRecord, WorkspaceBridge } from "../types";

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

export interface Answer {
  status: number;
  body: unknown;
}

/** Answers every request the provider makes: the records page, the workspace
 *  tree (empty) and whatever `routes` names by "METHOD path". */
export function stubAgent(page: RecordsPage, routes: Record<string, Answer> = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (!routes[key] && /^GET \/chat\/[^/]+\/events$/.test(key)) {
      return new FakeEventStream(String(input), init).response;
    }
    const answer: Answer =
      routes[key] ??
      (key === `GET /conversations/${CONVERSATION}/records`
        ? { status: 200, body: page }
        : key === "GET /workspace"
          ? { status: 200, body: { files: [] } }
          : key === "GET /capabilities"
            ? { status: 404, body: { error: "not found" } }
            : { status: 599, body: { error: `unexpected ${key}` } });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bridge: WorkspaceBridge = {
  snapshot: async () => new Map(),
  readFile: async () => "",
  applyChanges: async () => undefined,
};

export function installAgentGlobals() {
  FakeEventStream.opened = [];
  saveAgentSettings({ overrideUrl: AGENT_URL, panelOpen: true, panelWidth: AGENT_PANEL_DEFAULT_WIDTH, questionCards: true });
  saveConversationId("ws", CONVERSATION);
}

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

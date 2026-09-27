import { expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import { AGENT_PANEL_DEFAULT_WIDTH, saveAgentSettings, saveConversationId } from "../storage";
import type { JournalRecord, WorkspaceBridge } from "../types";

/** The provider under test, on a dev-override agent, with a conversation open
 *  and a workspace registered, talking to a fetch stub and a fake EventSource. */

export const AGENT_URL = "http://agent.test";
export const CONVERSATION = "conv-1";

export class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
  private readonly errorListeners: Array<(e: { data?: string }) => void> = [];
  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, listener: (e: { data?: string }) => void) {
    if (type === "error") this.errorListeners.push(listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(record: JournalRecord) {
    this.onmessage?.({ data: JSON.stringify(record), lastEventId: String(record.id) });
  }
  /** A server-sent `event: error` frame. */
  fail(code: string, message: string) {
    for (const listener of this.errorListeners) listener({ data: JSON.stringify({ code, message }) });
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
    const answer: Answer =
      routes[key] ??
      (key === `GET /conversations/${CONVERSATION}/records`
        ? { status: 200, body: page }
        : key === "GET /workspace"
          ? { status: 200, body: { files: [] } }
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
  FakeEventSource.opened = [];
  vi.stubGlobal("EventSource", FakeEventSource);
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

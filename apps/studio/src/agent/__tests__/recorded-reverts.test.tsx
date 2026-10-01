import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { AgentProvider, useAgent } from "../context";
import type { RecordsPage } from "../records";
import type { TurnRecords, WorkspaceBridge } from "../types";
import {
  CONVERSATION,
  FakeEventStream,
  capabilities,
  conversation,
  finishedTurn,
  installAgentGlobals,
  requestsMade,
  stubAgent,
  type Answer,
} from "./agent-harness";

beforeEach(installAgentGlobals);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const conversationRoute = `GET /conversations/${CONVERSATION}`;
const focus = () => act(() => void window.dispatchEvent(new Event("focus")));

/** A finished turn that modified `path` (`b-…` → `a-…`), reverted at `revertedAt` when given. */
function turn(turnId: string, path: string, revertedAt?: string): TurnRecords {
  return {
    ...finishedTurn(turnId, `change ${path}`),
    summary: {
      files: [
        { path, status: "modified", before: `b-${path}`, after: `a-${path}`, added: 1, removed: 1, firstLine: 1, checkExitCode: 0 },
      ],
      check: "clean",
      runs: [],
      usage: { totalTokens: 10 },
    },
    revert: revertedAt ? { revertedAt, files: [{ path, status: "modified", outcome: "restored" }] } : null,
  };
}

/** An agent whose workspace holds every path as it was before its turn, and an
 *  editor still holding what the turns left. */
function reverted(page: RecordsPage, paths: string[], over: Record<string, Answer> = {}) {
  const routes: Record<string, Answer> = {
    "GET /capabilities": capabilities(),
    [conversationRoute]: { status: 200, body: conversation({ revision: 1 }) },
    "GET /workspace": { status: 200, body: { files: paths.map((path) => ({ path, hash: `b-${path}` })) } },
    "GET /workspace/file": { status: 200, body: { content: "as before" } },
    ...over,
  };
  const fetchMock = stubAgent(page, routes);
  const held = new Map(paths.map((path) => [path, `a-${path}`]));
  const snapshot = vi.fn(async () => new Map(held));
  const applyChanges = vi.fn<WorkspaceBridge["applyChanges"]>(async (writes) => {
    // What it is given is the workspace's copy, which holds each path as before.
    for (const write of writes) held.set(write.path, `b-${write.path}`);
  });
  const bridge: WorkspaceBridge = { snapshot, readFile: async () => "", applyChanges, editorFile: () => null };
  return { fetchMock, routes, snapshot, applyChanges, bridge };
}

async function open(bridge: WorkspaceBridge) {
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

const workspaceReads = (fetchMock: ReturnType<typeof stubAgent>) =>
  requestsMade(fetchMock).filter((r) => r === "GET /workspace").length;

describe("a revert the agent recorded", () => {
  it("is applied to the editor when a conversation carrying it is first read", async () => {
    const { applyChanges, bridge } = reverted({ turns: [turn("t1", "a.yaml", "2026-09-30T10:00:00Z")], next: null }, ["a.yaml"]);
    await open(bridge);

    await waitFor(() => expect(applyChanges).toHaveBeenCalledWith([{ path: "a.yaml", content: "as before" }], []));
  });

  it("is applied when a revision poll delivers it, once per `revertedAt`", async () => {
    const page: RecordsPage = { turns: [turn("t1", "a.yaml")], next: null };
    const { routes, snapshot, applyChanges, bridge } = reverted(page, ["a.yaml"]);
    const { result } = await open(bridge);
    await waitFor(() => expect(result.current.conversation?.revision).toBe(1));
    expect(snapshot).not.toHaveBeenCalled();

    // Another client reverted the turn.
    page.turns = [turn("t1", "a.yaml", "2026-09-30T10:00:00Z")];
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 2 }) };
    focus();
    await waitFor(() => expect(applyChanges).toHaveBeenCalledTimes(1));
    expect(applyChanges).toHaveBeenCalledWith([{ path: "a.yaml", content: "as before" }], []);

    // The conversation moves again, the revert is the same one.
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 3, title: "Renamed" }) };
    focus();
    await waitFor(() => expect(result.current.conversation?.title).toBe("Renamed"));
    await waitFor(() => expect(result.current.conversation?.revision).toBe(3));

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(applyChanges).toHaveBeenCalledTimes(1);
  });

  it("takes one editor snapshot and one workspace tree for a read carrying two reverted turns", async () => {
    const { fetchMock, snapshot, applyChanges, bridge } = reverted(
      { turns: [turn("t1", "a.yaml", "2026-09-30T10:00:00Z"), turn("t2", "b.yaml", "2026-09-30T11:00:00Z")], next: null },
      ["a.yaml", "b.yaml"],
    );
    await open(bridge);

    await waitFor(() => expect(applyChanges).toHaveBeenCalledTimes(1));
    expect(applyChanges.mock.calls[0][0].map((write) => write.path)).toEqual(["a.yaml", "b.yaml"]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(workspaceReads(fetchMock)).toBe(1);
  });

  it("shows a failed apply, and the next send applies first and seeds only once that succeeded", async () => {
    const { fetchMock, applyChanges, bridge } = reverted(
      { turns: [turn("t1", "a.yaml", "2026-09-30T10:00:00Z")], next: null },
      ["a.yaml"],
      { "POST /chat": { status: 200, body: { turnId: "t2" } } },
    );
    applyChanges.mockRejectedValueOnce(new Error("disk full")).mockRejectedValueOnce(new Error("disk full"));
    const { result } = await open(bridge);
    const failure = "The editor's files could not be brought in line with the revert: disk full";
    await waitFor(() => expect(result.current.error).toBe(failure));

    act(() => result.current.send("go on"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe(failure);
    expect(applyChanges).toHaveBeenCalledTimes(2);
    expect(requestsMade(fetchMock).filter((r) => r.startsWith("POST"))).toEqual([]);

    act(() => result.current.retry());
    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    expect(applyChanges).toHaveBeenCalledTimes(3);
    expect(requestsMade(fetchMock).filter((r) => r.startsWith("POST"))).toEqual(["POST /chat"]);
  });

  it("stays pending when the workspace's tree cannot be read: shown, nothing changed, and applied by a later read", async () => {
    const page: RecordsPage = { turns: [turn("t1", "a.yaml", "2026-09-30T10:00:00Z")], next: null };
    const tree = { status: 200, body: { files: [{ path: "a.yaml", hash: "b-a.yaml" }] } };
    const { routes, applyChanges, bridge } = reverted(page, ["a.yaml"], {
      "GET /workspace": { status: 500, body: { error: "down" } },
    });
    const { result } = await open(bridge);

    await waitFor(() =>
      expect(result.current.error).toBe(
        "The editor's files could not be brought in line with the revert: GET /workspace failed (500)",
      ),
    );
    expect(applyChanges).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.conversation?.revision).toBe(1));

    // The same revert, read again once the tree answers: it was not marked applied.
    routes["GET /workspace"] = tree;
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 2 }) };
    focus();

    await waitFor(() => expect(applyChanges).toHaveBeenCalledWith([{ path: "a.yaml", content: "as before" }], []));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("stays pending when the workspace's tree answers with no file list: nothing deleted, and applied by a later read", async () => {
    const paths = ["a.yaml", "b.yaml"];
    // A turn that created both files, reverted: the agent's workspace holds neither.
    const created: TurnRecords = {
      ...finishedTurn("t1", "build"),
      summary: {
        files: paths.map((path) => ({
          path,
          status: "created" as const,
          before: null,
          after: `a-${path}`,
          added: 1,
          removed: 0,
          firstLine: 1,
          checkExitCode: 0,
        })),
        check: "clean",
        runs: [],
        usage: { totalTokens: 10 },
      },
      revert: {
        revertedAt: "2026-09-30T10:00:00Z",
        files: paths.map((path) => ({ path, status: "created" as const, outcome: "restored" as const })),
      },
    };
    const { routes, applyChanges, bridge } = reverted({ turns: [created], next: null }, paths, {
      "GET /workspace": { status: 200, body: {} },
    });
    const { result } = await open(bridge);

    await waitFor(() =>
      expect(result.current.error).toBe(
        "The editor's files could not be brought in line with the revert: GET /workspace returned no file list.",
      ),
    );
    expect(applyChanges).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.conversation?.revision).toBe(1));

    // The same revert, read again once the tree answers: it was not marked applied.
    routes["GET /workspace"] = { status: 200, body: { files: [] } };
    routes[conversationRoute] = { status: 200, body: conversation({ revision: 2 }) };
    focus();

    await waitFor(() => expect(applyChanges).toHaveBeenCalledWith([], paths));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("is not applied while a turn this client follows is running", async () => {
    const running: TurnRecords = { ...finishedTurn("t2", "more"), status: "running" };
    running.records = running.records.slice(0, 2);
    const { snapshot, bridge } = reverted(
      { turns: [turn("t1", "a.yaml", "2026-09-30T10:00:00Z"), running], next: null },
      ["a.yaml"],
    );
    const { result } = await open(bridge);

    await waitFor(() => expect(result.current.status).toBe("streaming"));
    expect(FakeEventStream.opened).toHaveLength(1);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

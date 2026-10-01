import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import { AgentProvider, useAgent } from "@/agent";
import type { TurnRevert, TurnSummary, WorkspaceBridge } from "@/agent";
import type { TurnRecords } from "@/agent/types";
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
import { DiagnosticsProvider } from "@/components/diagnostics/DiagnosticsContext";
import { emptyDiagnostics } from "@/language/engine-diagnostics";
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

const diagnostics = emptyDiagnostics();
const noFiles: string[] = [];

function Workspace({ bridge }: { bridge: WorkspaceBridge }) {
  const { registerWorkspace, setConversation } = useAgent();
  useEffect(() => {
    registerWorkspace(bridge);
    setConversation("ws");
  }, [bridge, registerWorkspace, setConversation]);
  return <AgentPanel />;
}

/** The panel inside an editor; `shown: false` renders the provider with the panel closed. */
function panel(bridge: WorkspaceBridge, shown = true) {
  return (
    <DiagnosticsProvider navigate={() => undefined} diagnostics={diagnostics} activeFilePaths={noFiles}>
      <AgentProvider>{shown ? <Workspace bridge={bridge} /> : null}</AgentProvider>
    </DiagnosticsProvider>
  );
}

const renderPanel = (bridge: WorkspaceBridge = fakeWorkspaceBridge) => render(panel(bridge));

/** An editor whose copy of `app/telo.yaml` hashes to `hash`. */
function editorHolding(hash: string) {
  const applyChanges = vi.fn(async () => undefined);
  const bridge: WorkspaceBridge = {
    snapshot: async () => new Map([["app/telo.yaml", hash]]),
    readFile: async () => "",
    applyChanges,
    editorFile: () => null,
  };
  return { bridge, applyChanges };
}

const reverted: TurnRevert = {
  revertedAt: "2026-09-30T10:00:00.000Z",
  files: [
    { path: "app/telo.yaml", status: "modified", outcome: "restored" },
    { path: "old.yaml", status: "deleted", outcome: "skipped" },
  ],
};

/** The agent's workspace after the revert: `app/telo.yaml` holds what it held before the turn. */
const revertedWorkspace: Record<string, Answer> = {
  "POST /chat/t1/revert": { status: 200, body: { revert: reverted, revision: 4 } },
  "GET /workspace": { status: 200, body: { files: [{ path: "app/telo.yaml", hash: "b1" }] } },
  "GET /workspace/file": { status: 200, body: { content: "port: 80\n" } },
};

const KEPT =
  "Restored in the agent's workspace, but not in the editor — the editor's copy is not what this turn left. " +
  "It will replace the restored file when you next send a message.";

const TURN_FEATURES = ["turn-changes", "turn-revert", "turn-summary", "turn-conclusion"];
const CONVERSATION_FEATURES = ["conversations", "conversation-truncation", "conversation-branching"];

/** An agent serving the conversation surfaces and every turn surface but `without`. */
function serving(without: string[] = []): Record<string, Answer> {
  return {
    "GET /capabilities": capabilities({
      features: [...CONVERSATION_FEATURES, ...TURN_FEATURES.filter((feature) => !without.includes(feature))],
    }),
    [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation({ revision: 3 }) },
  };
}

const summary: TurnSummary = {
  files: [
    { path: "app/telo.yaml", status: "modified", before: "b1", after: "a1", added: 3, removed: 1, firstLine: 7, checkExitCode: 0 },
    { path: "old.yaml", status: "deleted", before: "b2", after: null, added: 0, removed: 4, firstLine: null, checkExitCode: null },
  ],
  check: "clean",
  runs: [{ path: "tests/telo.yaml", exitCode: 1 }],
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
};

/** A finished turn with its summary; `limit` is its `finish` record's. */
function endedTurn(turnId: string, request: string, over: { summary?: TurnSummary; limit?: string } = {}): TurnRecords {
  const turn = finishedTurn(turnId, request, `reply to ${request}`);
  return {
    ...turn,
    summary: over.summary ?? summary,
    revert: null,
    records: turn.records.map((record) =>
      record.data.type === "finish" && over.limit ? { ...record, data: { ...record.data, limit: over.limit } } : record,
    ),
  };
}

const one = (turn: TurnRecords = endedTurn("t1", "build")) => ({ turns: [turn], next: null });

describe("the turn summary card", () => {
  it("shows what the turn changed, its check, runs and tokens", async () => {
    stubAgent(one(), serving());
    renderPanel();

    expect(await screen.findByText("2 files changed")).toBeTruthy();
    expect(screen.getByText("check: clean")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("tests/telo.yaml")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("120 tokens")).toBeTruthy();
    expect(screen.getByText("old.yaml")).toBeTruthy();
  });

  it("offers neither a file list, View changes nor Revert for a turn from before checkpoints", async () => {
    stubAgent(one(endedTurn("t1", "build", { summary: { ...summary, files: null } })), serving());
    renderPanel();

    expect(await screen.findByText("What this turn changed was not recorded.")).toBeTruthy();
    expect(screen.getByText("120 tokens")).toBeTruthy();
    expect(screen.queryByText("app/telo.yaml")).toBeNull();
    expect(screen.queryByRole("button", { name: "View changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });

  it("View changes reads the turn's changes and shows each file's hunks, marking one changed since", async () => {
    const fetchMock = stubAgent(one(), {
      ...serving(),
      "GET /chat/t1/changes": {
        status: 200,
        body: {
          files: [
            {
              ...summary.files![0],
              changedSince: true,
              hunks: [
                { oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: [{ op: "added", text: "port: 8080" }] },
              ],
            },
          ],
          revert: null,
        },
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "View changes" }));

    expect(await screen.findByText("changed since")).toBeTruthy();
    expect(screen.getByText("@@ -7,1 +7,1 @@")).toBeTruthy();
    expect(screen.getByText("+port: 8080")).toBeTruthy();
    expect(requestsMade(fetchMock)).toContain("GET /chat/t1/changes");
  });

  it("View changes marks a file changed since, one the agent did not compare, and leaves an unchanged one unmarked", async () => {
    const file = (path: string, changedSince: boolean | null) => ({
      ...summary.files![0],
      path,
      changedSince,
      hunks: null,
    });
    stubAgent(one(), {
      ...serving(),
      "GET /chat/t1/changes": {
        status: 200,
        body: { files: [file("same.yaml", false), file("moved.yaml", true), file("unread.yaml", null)], revert: null },
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "View changes" }));

    const marks = async (path: string) =>
      within((await screen.findByText(path)).parentElement!).queryAllByText(/changed since|not compared/).map((mark) => mark.textContent);
    expect(await marks("same.yaml")).toEqual([]);
    expect(await marks("moved.yaml")).toEqual(["changed since"]);
    expect(await marks("unread.yaml")).toEqual(["not compared"]);
  });

  it("Revert asks naming the file count, then lists what was skipped and pulls a restored file into the editor", async () => {
    const fetchMock = stubAgent(one(), { ...serving(), ...revertedWorkspace });
    // The editor's copy still holds what the turn left.
    const { bridge, applyChanges } = editorHolding("a1");
    renderPanel(bridge);

    await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Revert 2 files?")).toBeTruthy();
    expect(requestsMade(fetchMock)).not.toContain("POST /chat/t1/revert");

    await userEvent.click(within(dialog).getByRole("button", { name: "Revert" }));

    expect(await screen.findByText(/1 restored, 1 skipped\./)).toBeTruthy();
    expect(screen.getByText("Skipped, because they changed after the turn:").textContent).toContain("old.yaml");
    await waitFor(() =>
      expect(applyChanges).toHaveBeenCalledWith([{ path: "app/telo.yaml", content: "port: 80\n" }], []),
    );
    expect(screen.queryByText(KEPT)).toBeNull();
    // Still offered: repeating it evaluates the skipped path again.
    expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("names a restored path the editor kept its own copy of, and still does after the panel is closed and opened", async () => {
    const page = one();
    stubAgent(page, { ...serving(), ...revertedWorkspace });
    const { bridge, applyChanges } = editorHolding("my edit");
    const view = renderPanel(bridge);

    await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revert" }));

    expect((await screen.findByText(KEPT)).textContent).toContain("app/telo.yaml");
    expect(applyChanges).not.toHaveBeenCalled();
    // The agent recorded it: any later read of the conversation carries it.
    page.turns[0].revert = reverted;

    view.rerender(panel(bridge, false));
    expect(screen.queryByText(KEPT)).toBeNull();
    view.rerender(panel(bridge));

    expect((await screen.findByText(KEPT)).textContent).toContain("app/telo.yaml");
  });

  it("reverting a turn that created every file of a fresh workspace deletes them in the editor, and the next send seeds none back", async () => {
    const created: TurnSummary = {
      files: ["app/telo.yaml", "app/lib/telo.yaml"].map((path) => ({
        path,
        status: "created" as const,
        before: null,
        after: `a-${path}`,
        added: 3,
        removed: 0,
        firstLine: 1,
        checkExitCode: 0,
      })),
      check: "clean",
      runs: [],
      usage: { totalTokens: 10 },
    };
    const revert: TurnRevert = {
      revertedAt: "2026-09-30T10:00:00.000Z",
      files: created.files!.map(({ path }) => ({ path, status: "created", outcome: "restored" })),
    };
    // The agent deleted both: its workspace holds nothing.
    const fetchMock = stubAgent(one(endedTurn("t1", "build", { summary: created })), {
      ...serving(),
      "POST /chat/t1/revert": { status: 200, body: { revert, revision: 4 } },
      "POST /chat": { status: 200, body: { turnId: "t2" } },
    });
    const held = new Map(created.files!.map((file) => [file.path, file.after!]));
    const applyChanges = vi.fn<WorkspaceBridge["applyChanges"]>(async (writes, deletes) => {
      for (const path of deletes) held.delete(path);
    });
    renderPanel({ snapshot: async () => new Map(held), readFile: async () => "", applyChanges, editorFile: () => null });

    await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revert" }));

    expect(await screen.findByText(/2 restored, 0 skipped\./)).toBeTruthy();
    await waitFor(() => expect(applyChanges).toHaveBeenCalledWith([], ["app/telo.yaml", "app/lib/telo.yaml"]));
    expect(screen.queryByText(KEPT)).toBeNull();

    await userEvent.type(screen.getByPlaceholderText("Message the agent…"), "now a queue{Enter}");

    await waitFor(() => expect(requestsMade(fetchMock)).toContain("POST /chat"));
    expect(requestsMade(fetchMock)).not.toContain("POST /workspace");
  });

  it("shows the agent's refusal of a revert, by its code", async () => {
    stubAgent(one(), {
      ...serving(),
      "POST /chat/t1/revert": refused(409, "ERR_TURN_IN_PROGRESS", { activeTurnId: "t9" }),
    });
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revert" }));

    expect(await screen.findByText(/ERR_TURN_IN_PROGRESS/)).toBeTruthy();
  });
});

describe("Continue after a spent step budget", () => {
  it("is offered on the last such turn only, and sends exactly `Continue.` as a new turn", async () => {
    const fetchMock = stubAgent(
      {
        turns: [endedTurn("t1", "first", { limit: "max-steps" }), endedTurn("t2", "second", { limit: "max-steps" })],
        next: null,
      },
      { ...serving(), "POST /chat": { status: 200, body: { turnId: "t3" } } },
    );
    renderPanel();
    await screen.findByText("reply to second");

    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => expect(FakeEventStream.opened).toHaveLength(1));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => new URL(String(url)).pathname)).toEqual(["/chat"]);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ conversationId: CONVERSATION, message: "Continue." });
    expect(screen.getByText("Continue.")).toBeTruthy();
  });

  it("is not offered on an earlier turn, nor on a turn that failed", async () => {
    const failed: TurnRecords = {
      ...finishedTurn("t2", "second", "reply to second"),
      status: "failed",
      error: { code: "ERR_AGENT_MAX_STEPS", message: "The agent ran out of steps." },
      summary,
      revert: null,
    };
    failed.records = failed.records.slice(0, 2);
    stubAgent({ turns: [endedTurn("t1", "first", { limit: "max-steps" }), failed], next: null }, serving());
    renderPanel();

    expect(await screen.findByText("The agent ran out of steps.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("an agent that lacks a turn feature", () => {
  it.each([
    ["turn-summary", ["2 files changed", "View changes", "Revert"], ["Continue"]],
    ["turn-revert", ["Revert"], ["2 files changed", "View changes", "Continue"]],
    ["turn-changes", ["View changes"], ["2 files changed", "Revert", "Continue"]],
    ["turn-conclusion", ["Continue"], ["2 files changed", "View changes", "Revert"]],
  ])("without %s, only that surface is absent", async (feature, absent, present) => {
    stubAgent(one(endedTurn("t1", "build", { limit: "max-steps" })), serving([feature]));
    renderPanel();
    await screen.findByText("reply to build");

    for (const text of present) expect(await screen.findByText(text)).toBeTruthy();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
  });

  it("with none of them, shows no summary card and no Continue", async () => {
    const fetchMock = stubAgent(one(endedTurn("t1", "build", { limit: "max-steps" })), serving(TURN_FEATURES));
    renderPanel();
    await screen.findByText("reply to build");
    await waitFor(() => expect(requestsMade(fetchMock)).toContain("GET /capabilities"));

    for (const text of ["2 files changed", "View changes", "Revert", "Continue"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });
});

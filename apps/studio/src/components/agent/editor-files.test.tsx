import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";

import { AgentProvider, useAgent } from "@/agent";
import type { WorkspaceBridge } from "@/agent";
import type { TurnRecords } from "@/agent/types";
import {
  CONVERSATION,
  capabilities,
  conversation,
  installAgentGlobals,
  stubAgent,
} from "@/agent/__tests__/agent-harness";
import { saveConversationId } from "@/agent/storage";
import { DiagnosticsProvider } from "@/components/diagnostics/DiagnosticsContext";
import { editorWorkspaceBridge } from "@/components/editor-workspace-bridge";
import { emptyDiagnostics } from "@/language/engine-diagnostics";
import { LocalStorageAdapter } from "@/loader/adapters/local-storage";
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

function Workspace({ bridge, root }: { bridge: WorkspaceBridge; root: string }) {
  const { registerWorkspace, setConversation } = useAgent();
  useEffect(() => {
    registerWorkspace(bridge);
    setConversation(root);
  }, [bridge, root, registerWorkspace, setConversation]);
  return <AgentPanel />;
}

/** The bridge the editor registers for a workspace at `root`, over a real
 *  adapter, and the paths that adapter was asked to write. */
function editorAt(root: string) {
  const adapter = new LocalStorageAdapter(root);
  const written = vi.spyOn(adapter, "writeFile");
  const bridge = editorWorkspaceBridge({ rootDir: root, adapter: () => adapter, afterFileMutation: async () => undefined });
  return { bridge, written };
}

function renderPanel(bridge: WorkspaceBridge, root: string, turn: TurnRecords) {
  stubAgent(
    { turns: [turn], next: null },
    {
      "GET /capabilities": capabilities({ features: ["conversations", "turn-changes", "turn-summary"] }),
      [`GET /conversations/${CONVERSATION}`]: { status: 200, body: conversation() },
    },
  );
  saveConversationId(root, CONVERSATION);
  const navigate = vi.fn();
  render(
    <DiagnosticsProvider navigate={navigate} diagnostics={diagnostics} activeFilePaths={noFiles}>
      <AgentProvider>
        <Workspace bridge={bridge} root={root} />
      </AgentProvider>
    </DiagnosticsProvider>,
  );
  return navigate;
}

/** A turn of one tool call with `output`, answered `Done.`. */
function turnWith(output: Record<string, unknown>, summary: TurnRecords["summary"] = null): TurnRecords {
  return {
    turnId: "t1",
    status: "finished",
    error: null,
    summary,
    revert: null,
    records: [
      { id: 1, data: { type: "user-message", content: "build", model: "m" } },
      { id: 2, data: { type: "tool-call", toolCall: { id: "c", name: "write_file", arguments: {} } } },
      { id: 3, data: { type: "tool-result", toolResult: { toolCallId: "c", name: "write_file", content: "", output } } },
      { id: 4, data: { type: "text-delta", delta: "Done." } },
      { id: 5, data: { type: "finish", finishReason: "stop" } },
    ],
  };
}

const change = { path: "app/telo.yaml", status: "created", before: null, after: "a1", added: 2, removed: 0 } as const;

describe("a path the agent names", () => {
  it.each([["/workspace"], ["/home/me/projects/shop"]])(
    "opens the file the editor wrote for it, in a workspace at %s",
    async (root) => {
      const { bridge, written } = editorAt(root);
      await bridge.applyChanges([{ path: "app/telo.yaml", content: "kind: Telo.Application\n" }], []);
      const file = written.mock.calls[0][0];

      const navigate = renderPanel(
        bridge,
        root,
        turnWith(
          {
            path: "app/telo.yaml",
            checkExitCode: 0,
            checkReport: null,
            changes: [change],
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 14, newLines: 1, lines: [{ op: "added", text: "x" }] }],
          },
          {
            files: [
              { ...change, firstLine: 7, checkExitCode: 0 },
              { path: "old.yaml", status: "deleted", before: "b2", after: null, added: 0, removed: 1, firstLine: null, checkExitCode: null },
            ],
            check: "clean",
            runs: [],
            usage: { totalTokens: 10 },
          },
        ),
      );

      await screen.findByText("2 files changed");
      const [onCard, onSummary] = screen.getAllByRole("button", { name: "app/telo.yaml" });
      await userEvent.click(onCard);
      await userEvent.click(onSummary);

      const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 0 } });
      expect(navigate.mock.calls).toEqual([
        [file, at(13)],
        [file, at(6)],
      ]);
      // A deleted file is listed, with nothing to open.
      expect(screen.getByText("old.yaml").closest("button")).toBeNull();
    },
  );

  it("is plain text when it names no editor file", async () => {
    const { bridge } = editorAt("/workspace");
    const named = ["app/telo.yaml", ".probes/x.yaml", "../x.yaml", "/etc/x", "oci://host/mod"];
    const navigate = renderPanel(
      bridge,
      "/workspace",
      turnWith({
        path: "app/telo.yaml",
        checkExitCode: 1,
        checkReport: {
          diagnostics: named.map((file) => ({ file, line: 1, column: 1, severity: "error", message: "bad" })),
        },
      }),
    );

    expect((await screen.findByText("app/telo.yaml:1:1 bad")).closest("button")).not.toBeNull();
    for (const file of named.slice(1)) {
      expect(screen.getByText(`${file}:1:1 bad`).closest("button")).toBeNull();
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});

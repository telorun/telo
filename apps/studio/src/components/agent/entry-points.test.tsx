import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { DiagnosticSeverity } from "@telorun/analyzer";

import { AgentProvider, useAgent } from "@/agent";
import { finishedTurn, installAgentGlobals, requestsMade, stubAgent } from "@/agent/__tests__/agent-harness";
import { DiagnosticPopoverContent } from "@/components/diagnostics/DiagnosticPopoverContent";
import { editorWorkspaceBridge } from "@/components/editor-workspace-bridge";

beforeEach(installAgentGlobals);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const bridge = editorWorkspaceBridge({ rootDir: "/ws", adapter: () => null, afterFileMutation: async () => undefined });

const diagnostic = {
  filePath: "/ws/apps/todo/telo.yaml",
  diagnostic: {
    range: { start: { line: 11, character: 2 }, end: { line: 11, character: 9 } },
    severity: DiagnosticSeverity.Error,
    code: "UNDEFINED_KIND",
    source: "telo",
    message: "Kind 'Http.Sever' is not defined.",
  },
};

/** The editor shell's part: a workspace, and whether it offers the panel. */
function Shell({ panelOffered }: { panelOffered: boolean }) {
  const agent = useAgent();
  const { registerWorkspace, setConversation, setPanelAvailable } = agent;
  useEffect(() => {
    registerWorkspace(bridge);
    setConversation("ws");
    setPanelAvailable(panelOffered);
  }, [panelOffered, registerWorkspace, setConversation, setPanelAvailable]);
  return (
    <>
      <DiagnosticPopoverContent diagnostics={[diagnostic]} />
      <textarea aria-label="composer" value={agent.composer.text} onChange={(e) => agent.setComposerText(e.target.value)} />
    </>
  );
}

const renderShell = (panelOffered: boolean) =>
  render(
    <AgentProvider>
      <Shell panelOffered={panelOffered} />
    </AgentProvider>,
  );

describe("Fix with AI on a diagnostic", () => {
  it("puts its code, file, line and message into the composer, editable, and sends nothing", async () => {
    const fetchMock = stubAgent({ turns: [finishedTurn("t1", "first")], next: null });
    renderShell(true);

    await userEvent.click(await screen.findByRole("button", { name: "Fix with AI" }));

    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "composer" });
    expect(composer.value).toBe(
      "Fix this diagnostic: UNDEFINED_KIND at `apps/todo/telo.yaml` line 12\n\nKind 'Http.Sever' is not defined.",
    );
    await userEvent.type(composer, " Keep the port.");
    expect(composer.value.endsWith("is not defined. Keep the port.")).toBe(true);
    expect(requestsMade(fetchMock)).not.toContain("POST /chat");
  });

  it("is not offered where the agent panel is not", async () => {
    stubAgent({ turns: [finishedTurn("t1", "first")], next: null });
    renderShell(false);

    await screen.findByText("UNDEFINED_KIND");
    expect(screen.queryByRole("button", { name: "Fix with AI" })).toBeNull();
  });
});

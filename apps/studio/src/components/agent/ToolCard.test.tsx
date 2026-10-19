import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolCallView } from "@/agent";
import { DiagnosticsProvider } from "@/components/diagnostics/DiagnosticsContext";
import { emptyDiagnostics } from "@/language/engine-diagnostics";
import { ToolCard } from "./ToolCard";
import { EditorFileContext } from "./WorkspaceFileLink";

afterEach(() => {
  cleanup();
});

const diagnostics = emptyDiagnostics();
const noFiles: string[] = [];

const editorFile = (path: string) => `editor:${path}`;

/** The card inside an editor that has a file for every path; returns the editor's `navigate`. */
function renderCard(tool: ToolCallView, diffs = true) {
  const navigate = vi.fn();
  render(
    <DiagnosticsProvider navigate={navigate} diagnostics={diagnostics} activeFilePaths={noFiles}>
      <EditorFileContext.Provider value={editorFile}>
        <ToolCard tool={tool} diffs={diffs} />
      </EditorFileContext.Provider>
    </DiagnosticsProvider>,
  );
  return navigate;
}

const edit: ToolCallView = {
  toolCallId: "e",
  name: "edit_file",
  args: { path: "app/telo.yaml", oldString: "port: 80", newString: "port: 8080" },
  state: "done",
  output: "edited app/telo.yaml\ncheck: clean",
  structured: {},
  path: "app/telo.yaml",
  checkExitCode: 0,
  diagnostics: [],
  changes: [{ path: "app/telo.yaml", status: "modified", before: "b1", after: "a1", added: 1, removed: 1 }],
  hunks: [
    {
      oldStart: 12,
      oldLines: 3,
      newStart: 14,
      newLines: 3,
      lines: [
        { op: "context", text: "server:" },
        { op: "removed", text: "  port: 80" },
        { op: "added", text: "  port: 8080" },
      ],
    },
  ],
};

describe("ToolCard", () => {
  it("shows a write's diff and line counts, and opens the file at its first hunk", async () => {
    const navigate = renderCard(edit);

    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText("check: clean")).toBeTruthy();
    // Folded until asked for.
    expect(screen.queryByText(/port: 8080/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /edit_file/ }));
    expect(screen.getByText("+ port: 8080", { normalizer: (text) => text.replace(/\s+/g, " ").trim() })).toBeTruthy();
    expect(screen.getByText(/@@ -12,3 \+14,3 @@/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "app/telo.yaml" }));
    const at = { line: 13, character: 0 };
    expect(navigate).toHaveBeenCalledWith("editor:app/telo.yaml", { start: at, end: at });
  });

  it("puts a failed check's diagnostics before the diff, on a card that opens by itself", () => {
    renderCard({
      ...edit,
      checkExitCode: 1,
      diagnostics: [{ file: "app/telo.yaml", line: 14, column: 3, severity: "error", message: "bad port" }],
    });

    const diagnostic = screen.getByText("app/telo.yaml:14:3 bad port");
    const hunk = screen.getByText(/@@ -12,3 \+14,3 @@/);
    expect(diagnostic.compareDocumentPosition(hunk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no diff for an agent that does not serve turn-changes: the path and the verdict only", async () => {
    renderCard(edit, false);

    expect(screen.getByRole("button", { name: "app/telo.yaml" })).toBeTruthy();
    expect(screen.getByText("check: clean")).toBeTruthy();
    expect(screen.queryByText("+1")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /edit_file/ }));
    expect(screen.queryByText(/@@/)).toBeNull();
  });

  it("opens a failed check's diagnostic at its file and line", async () => {
    const navigate = renderCard({
      toolCallId: "c",
      name: "telo_check",
      state: "done",
      output: "app/telo.yaml:3:5 SCHEMA_VIOLATION bad field",
      structured: {},
      path: "app/telo.yaml",
      checkExitCode: 1,
      diagnostics: [
        { file: "app/lib/telo.yaml", line: 3, column: 5, severity: "error", code: "SCHEMA_VIOLATION", message: "bad field" },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "app/lib/telo.yaml:3:5 SCHEMA_VIOLATION bad field" }));

    const at = { line: 2, character: 4 };
    expect(navigate).toHaveBeenCalledWith("editor:app/lib/telo.yaml", { start: at, end: at });
  });

  it("shows a command's exit code and its last 20 lines, the full output and stderr in a dialog", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    renderCard({
      toolCallId: "r",
      name: "run_manifest",
      args: { path: "tests/telo.yaml" },
      state: "done",
      output: "…",
      structured: {},
      run: { exitCode: 1, output: `${lines.join("\n")}\n`, messages: "kernel: boom" },
    });

    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("tests/telo.yaml")).toBeTruthy();
    expect(screen.getByText(/line 25/).textContent).toBe(lines.slice(5).join("\n"));
    expect(screen.queryByText("kernel: boom")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "View full output" }));

    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/line 25/).textContent).toBe(`${lines.join("\n")}\n`);
    expect(dialog.getByText("kernel: boom")).toBeTruthy();
  });

  it("shows no exit badge for a command that succeeded", () => {
    renderCard({
      toolCallId: "r0",
      name: "telo",
      args: { args: ["module", "manifest", "oci://ghcr.io/telorun/app@0.3.0"] },
      state: "done",
      output: "…",
      structured: {},
      run: { exitCode: 0, output: "ok\n", messages: "" },
    });

    expect(screen.getByText("module manifest oci://ghcr.io/telorun/app@0.3.0")).toBeTruthy();
    expect(screen.queryByText(/exit 0/)).toBeNull();
    expect(screen.getByLabelText("Completed")).toBeTruthy();
  });

  it("draws a failed call without a structured result in the same row as any other", () => {
    renderCard({ toolCallId: "x", name: "get_kinds", args: { refs: ["a"] }, state: "error", output: "hub unreachable" });

    expect(screen.getByRole("button", { name: /get_kinds/ })).toBeTruthy();
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(screen.getByText("hub unreachable")).toBeTruthy();
  });

  it("shows any other result under the tool's name and scalar arguments, its text parts as text", async () => {
    renderCard({
      toolCallId: "s",
      name: "search_resources",
      args: { query: "queue", filters: { category: "data" } },
      state: "done",
      output: '[{"type":"text","text":"Found 2 modules"}]',
      structured: [{ type: "text", text: "Found 2 modules" }],
    });

    expect(screen.getByText("queue")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /search_resources/ }));

    expect(screen.getByText("Found 2 modules").tagName).toBe("PRE");
    expect(screen.getByText("category:")).toBeTruthy();
    expect(document.body.textContent).not.toContain('"type"');
  });
});

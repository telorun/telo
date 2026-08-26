import { parseToAst } from "@telorun/analyzer";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleDocument, ModuleSourceFile } from "../model";
import { DetailYamlPane } from "./DetailYamlPane";

// Monaco does not run under jsdom. A textarea mirroring the value /
// onValueChange contract is enough to assert what the pane shows and what it
// commits (the `code-field` tests take the same route).
vi.mock("./code-editor", () => ({
  CodeEditor: ({
    value,
    onValueChange,
    readOnly,
  }: {
    value: string;
    onValueChange: (next: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      data-testid="yaml-editor"
      readOnly={readOnly}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
}));

const TEXT = `kind: Run.Sequence
metadata:
  name: main
steps:
  - name: fetch
    invoke: !ref client
    inputs:
      url: https://example.com
`;

function files(): ModuleSourceFile[] {
  return [{ filePath: "/t.yaml", text: TEXT, documents: parseToAst(TEXT) }];
}

type SourceEdit = (filePath: string, doc: ModuleDocument) => void;

function pane(pointer: string, onSourceEdit: SourceEdit = () => undefined, readOnly = false) {
  return render(
    <DetailYamlPane
      sourceFiles={files()}
      resource={{ kind: "Run.Sequence", name: "main" }}
      pointer={pointer}
      readOnly={readOnly}
      onSourceEdit={onSourceEdit}
      diagnostics={[]}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("DetailYamlPane", () => {
  it("shows only the selected pointer's source", () => {
    pane("/steps/0/inputs");
    expect(screen.getByTestId("yaml-editor")).toHaveValue("url: https://example.com");
  });

  it("shows the whole resource document for an empty pointer", () => {
    pane("");
    expect(screen.getByTestId("yaml-editor")).toHaveValue(TEXT.trimEnd());
  });

  it("commits a spliced whole-file edit after the debounce", () => {
    const onSourceEdit = vi.fn<(filePath: string, doc: ModuleDocument) => void>();
    pane("/steps/0/inputs", onSourceEdit);

    fireEvent.change(screen.getByTestId("yaml-editor"), {
      target: { value: "url: https://example.org\nmethod: POST" },
    });
    expect(onSourceEdit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(500));

    expect(onSourceEdit).toHaveBeenCalledTimes(1);
    const [filePath, doc] = onSourceEdit.mock.calls[0];
    expect(filePath).toBe("/t.yaml");
    // Re-indented into the node's own depth, everything else byte-identical.
    expect(doc.loaded.text).toBe(
      TEXT.replace(
        "      url: https://example.com",
        "      url: https://example.org\n      method: POST",
      ),
    );
  });

  it("flushes a pending edit when the selection moves away", () => {
    const onSourceEdit = vi.fn<(filePath: string, doc: ModuleDocument) => void>();
    const view = pane("/steps/0/inputs", onSourceEdit);

    fireEvent.change(screen.getByTestId("yaml-editor"), {
      target: { value: "url: https://example.org" },
    });
    view.rerender(
      <DetailYamlPane
        sourceFiles={files()}
        resource={{ kind: "Run.Sequence", name: "main" }}
        pointer="/metadata"
        readOnly={false}
        onSourceEdit={onSourceEdit}
        diagnostics={[]}
      />,
    );

    expect(onSourceEdit).toHaveBeenCalledTimes(1);
    expect(onSourceEdit.mock.calls[0][1].loaded.text).toContain("url: https://example.org");
    // ...and the pane has moved on to the new pointer.
    expect(screen.getByTestId("yaml-editor")).toHaveValue("name: main");
  });

  it("reports a parse failure and commits nothing", () => {
    const onSourceEdit = vi.fn();
    pane("/steps/0/inputs", onSourceEdit);

    fireEvent.change(screen.getByTestId("yaml-editor"), {
      target: { value: "url: [unclosed" },
    });
    act(() => void vi.advanceTimersByTime(500));

    expect(onSourceEdit).not.toHaveBeenCalled();
    expect(screen.getByText(/unexpected end|flow sequence|expected/i)).toBeInTheDocument();
  });

  it("says so when the pointer names a path the source does not write", () => {
    pane("/steps/0/retry");
    expect(screen.queryByTestId("yaml-editor")).not.toBeInTheDocument();
    expect(screen.getByText(/\/steps\/0\/retry/)).toBeInTheDocument();
  });

  it("does not commit while the module is read-only", () => {
    const onSourceEdit = vi.fn();
    pane("/steps/0/inputs", onSourceEdit, true);

    expect(screen.getByTestId("yaml-editor")).toHaveAttribute("readonly");
    act(() => void vi.advanceTimersByTime(500));
    expect(onSourceEdit).not.toHaveBeenCalled();
  });
});

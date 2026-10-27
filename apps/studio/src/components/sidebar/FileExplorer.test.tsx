import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { FileNode } from "../../loader";
import { FileExplorer } from "./FileExplorer";

afterEach(() => {
  cleanup();
});

const ROOT = "/ws";
const TREE: FileNode[] = [
  {
    name: "apps",
    path: "/ws/apps",
    isDirectory: true,
    children: [{ name: "telo.yaml", path: "/ws/apps/telo.yaml", isDirectory: false }],
  },
];

function renderExplorer() {
  const handlers = {
    onToggleDir: vi.fn(),
    onOpenFile: vi.fn(),
    onCreateFile: vi.fn(async () => {}),
    onCreateFolder: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onMove: vi.fn(async () => {}),
  };
  render(
    <FileExplorer
      rootDir={ROOT}
      tree={TREE}
      expandedDirs={new Set(["/ws/apps"])}
      activeFilePath={null}
      {...handlers}
    />,
  );
  return handlers;
}

describe("FileExplorer new folder", () => {
  it("focuses the name field after New folder from the header and creates the folder on Enter", async () => {
    const user = userEvent.setup();
    const { onCreateFolder } = renderExplorer();

    await user.click(screen.getByTitle("New folder"));
    const input = screen.getByPlaceholderText("folder-name");
    expect(input).toHaveFocus();

    await user.type(input, "docs{Enter}");
    expect(onCreateFolder).toHaveBeenCalledWith(ROOT, "docs");
  });

  it("focuses the name field after New folder from a directory's context menu and creates the folder on Enter", async () => {
    const user = userEvent.setup();
    const { onCreateFolder } = renderExplorer();

    fireEvent.contextMenu(screen.getByText("apps"));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));

    const input = await screen.findByPlaceholderText("folder-name");
    expect(input).toHaveFocus();

    await user.type(input, "docs{Enter}");
    expect(onCreateFolder).toHaveBeenCalledWith("/ws/apps", "docs");
  });
});

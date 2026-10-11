import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EmptyWorkspacePanel } from "./EmptyWorkspacePanel";

afterEach(() => cleanup());

describe("an open workspace with no modules", () => {
  it("takes the request for the agent and offers the starters beside it", async () => {
    const onBuild = vi.fn(async () => true);
    const onStart = vi.fn();
    render(<EmptyWorkspacePanel onBuild={onBuild} onStartFromStarter={onStart} />);
    const input = screen.getByLabelText("What to build") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Build a ticket API" } });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("Start from a starter"));

    expect(onBuild).toHaveBeenCalledWith("Build a ticket API");
    expect(onStart).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("says the workspace is empty and offers only the starters where the agent is not offered", () => {
    render(<EmptyWorkspacePanel onStartFromStarter={() => undefined} />);
    expect(screen.queryByLabelText("What to build")).toBeNull();
    expect(screen.getByText("This workspace has no modules yet")).toBeTruthy();
    expect(screen.getByText("Start from a starter")).toBeTruthy();
  });

  it("offers no starters while editing is paused", () => {
    render(<EmptyWorkspacePanel onBuild={async () => true} />);
    expect(screen.queryByText("Start from a starter")).toBeNull();
  });

  it("puts the starters ahead of the request for the agent", () => {
    render(<EmptyWorkspacePanel onBuild={async () => true} onStartFromStarter={() => undefined} />);
    const starters = screen.getByText("Start from a starter");
    const request = screen.getByLabelText("What to build");
    expect(starters.compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

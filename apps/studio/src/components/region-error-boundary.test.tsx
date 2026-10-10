import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegionErrorBoundary } from "./RegionErrorBoundary";

let broken = true;

function Graph() {
  if (broken) throw new Error("Only local $ref is supported for now: telo://Ui/Node");
  return <p>graph drawn</p>;
}

describe("RegionErrorBoundary", () => {
  beforeEach(() => {
    broken = true;
    // React reports every caught render error; the report is not under test.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the failure in the region's place and leaves its sibling standing", () => {
    render(
      <div>
        <p>sidebar</p>
        <RegionErrorBoundary region="graph">
          <Graph />
        </RegionErrorBoundary>
      </div>,
    );

    expect(screen.getByText("sidebar")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The graph could not be displayed");
    expect(screen.getByRole("alert")).toHaveTextContent("telo://Ui/Node");
    expect(console.error).toHaveBeenCalled();
  });

  it("renders the region again when asked to, once the cause is gone", async () => {
    render(
      <RegionErrorBoundary region="graph">
        <Graph />
      </RegionErrorBoundary>,
    );

    broken = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("graph drawn")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the failure again when the cause is still there", async () => {
    render(
      <RegionErrorBoundary region="graph">
        <Graph />
      </RegionErrorBoundary>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByRole("alert")).toHaveTextContent("The graph could not be displayed");
  });

  it("clears the failure when what it shows changes", () => {
    const { rerender } = render(
      <RegionErrorBoundary region="view" resetKey="app#topology">
        <Graph />
      </RegionErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    broken = false;
    rerender(
      <RegionErrorBoundary region="view" resetKey="app#source">
        <Graph />
      </RegionErrorBoundary>,
    );

    expect(screen.getByText("graph drawn")).toBeInTheDocument();
  });
});

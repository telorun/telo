import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredModelNotice } from "./StructuredModelNotice";

afterEach(cleanup);

describe("StructuredModelNotice", () => {
  it("names the version that predates structured editing and opens the source view", () => {
    const onOpenSource = vi.fn();
    render(<StructuredModelNotice status={{ state: "unsupported", version: "0.101.0" }} onOpenSource={onOpenSource} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Telo 0.101.0 predates structured editing — edit this module in the source view.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source view" }));
    expect(onOpenSource).toHaveBeenCalledOnce();
  });

  it("shows why the read failed and retries it", () => {
    const onRetry = vi.fn();
    render(
      <StructuredModelNotice
        status={{ state: "failed", error: "the view model of /ws/app/telo.yaml could not be read: boom" }}
        onOpenSource={() => undefined}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("could not be read: boom");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says a module the engine is not analysing has no structure yet", () => {
    render(<StructuredModelNotice status={{ state: "absent" }} onOpenSource={() => undefined} />);

    expect(screen.getByText("Analyzing module…")).toBeInTheDocument();
    expect(screen.getByText("The language engine is not analysing this module yet.")).toBeInTheDocument();
  });
});

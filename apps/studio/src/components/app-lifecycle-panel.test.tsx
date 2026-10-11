import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { STARTER_PROMPTS } from "@/agent";
import { AppLifecyclePanel } from "./AppLifecyclePanel";

vi.mock("../cloud/context", () => ({
  useCloud: () => ({ session: { status: "unavailable" } }),
}));
vi.mock("./cloud/OpenCloudProjectDialog", () => ({ OpenCloudProjectDialog: () => null }));

afterEach(() => cleanup());

function panel(onBuild?: (request: string) => Promise<boolean>) {
  render(
    <AppLifecyclePanel onOpen={() => undefined} onStartFromStarter={() => undefined} openMode="single" onBuild={onBuild} />,
  );
}

const input = () => screen.getByLabelText("What to build") as HTMLTextAreaElement;

describe("the closed-workspace screen", () => {
  it("offers no request input where the agent is not offered", () => {
    panel();
    expect(screen.queryByLabelText("What to build")).toBeNull();
    expect(screen.getByText("Open browser workspace")).toBeTruthy();
  });

  it("hands the typed request over on Enter and clears it once a workspace opened", async () => {
    const onBuild = vi.fn(async () => true);
    panel(onBuild);
    fireEvent.change(input(), { target: { value: "Build a ticket API" } });

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(onBuild).toHaveBeenCalledWith("Build a ticket API");
    await waitFor(() => expect(input().value).toBe(""));
  });

  it("keeps the request when no workspace was opened", async () => {
    const onBuild = vi.fn(async () => false);
    panel(onBuild);
    fireEvent.change(input(), { target: { value: "Build a ticket API" } });

    fireEvent.click(screen.getByLabelText("Build"));

    await waitFor(() => expect(input().disabled).toBe(false));
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("Build a ticket API");
  });

  it("adds a line on Shift+Enter and sends nothing while empty", () => {
    const onBuild = vi.fn(async () => true);
    panel(onBuild);

    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "Build" } });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });

    expect(onBuild).not.toHaveBeenCalled();
  });

  it("fills the input from a starter without sending it", () => {
    const onBuild = vi.fn(async () => true);
    panel(onBuild);

    fireEvent.click(screen.getByText(STARTER_PROMPTS[0].label));

    expect(input().value).toBe(STARTER_PROMPTS[0].prompt);
    expect(onBuild).not.toHaveBeenCalled();
  });
});

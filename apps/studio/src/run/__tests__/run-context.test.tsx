import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { RunProvider, useRun, type WorkspaceBinding } from "../context";
import { FakeRunner, emptyBridge, memoryResumeSecretStore } from "./fake-runner";

const APP_A = "/workspace/a/telo.yaml";
const APP_B = "/workspace/b/telo.yaml";

function wrapper({ children }: { children: ReactNode }) {
  return <RunProvider>{children}</RunProvider>;
}

/** Bind the provider to a workspace holding apps `a` and `b` on a fake runner,
 *  and bring the session up. */
async function bound(run: () => ReturnType<typeof useRun>) {
  const runner = new FakeRunner();
  const binding: WorkspaceBinding = {
    workspaceKey: "/workspace",
    entry: { mode: "manual", workspace: "device:1" },
    mode: "manual",
    runner: { id: "r1", name: "Fake", adapter: runner.adapter, config: {} },
    termsAccepted: () => true,
    secrets: memoryResumeSecretStore(),
    identity: null,
    saveEntry: () => undefined,
    bridge: emptyBridge,
    prepareRun: async () => ({ env: {}, io: "tty" }),
  };
  act(() => {
    run().setDesiredApps({
      settled: true,
      versioned: false,
      apps: [
        { appPath: APP_A, spec: { name: "a", entryRelativePath: "a/telo.yaml" } },
        { appPath: APP_B, spec: { name: "b", entryRelativePath: "b/telo.yaml" } },
      ],
    });
    run().bindWorkspace(binding);
  });
  await waitFor(() => expect(runner.sessions.get("s1")).toBeDefined());
  await waitFor(() => expect(run().session?.phase).toBe("live"));
  const fake = runner.sessions.get("s1")!;
  act(() => fake.up());
  return { runner, fake };
}

async function runApp(run: () => ReturnType<typeof useRun>, appPath: string) {
  await act(async () => {
    await run().runApp(appPath, { env: {}, io: "tty" });
  });
}

describe("run state is keyed by Application", () => {
  beforeEach(() => localStorage.clear());

  it("opens only the run app's dock, and leaves the other app's closed", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    await bound(() => result.current);

    expect(result.current.dockForApp(APP_A).open).toBe(false);
    await runApp(() => result.current, APP_A);

    expect(result.current.dockForApp(APP_A).open).toBe(true);
    expect(result.current.dockForApp(APP_B).open).toBe(false);
  });

  it("keeps each app's dock height independent", () => {
    const { result } = renderHook(() => useRun(), { wrapper });

    act(() => result.current.setDockHeight(APP_A, 420));
    act(() => result.current.setDockHeight(APP_B, 200));

    expect(result.current.dockForApp(APP_A).height).toBe(420);
    expect(result.current.dockForApp(APP_B).height).toBe(200);
  });

  it("refuses to shrink a dock below its minimum", () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    act(() => result.current.setDockHeight(APP_A, 10));
    expect(result.current.dockForApp(APP_A).height).toBeGreaterThanOrEqual(160);
  });

  it("shows the app's live run without anything selecting it", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    await bound(() => result.current);

    await runApp(() => result.current, APP_A);

    await waitFor(() => expect(result.current.selectedRunForApp(APP_A)?.runId).toBe("run-1"));
    expect(result.current.selectedRunForApp(APP_A)?.status.kind).toBe("running");
    expect(result.current.selectedRunForApp(APP_B)).toBeNull();
  });

  it("holds a blocker against the app that could not start, not the window", () => {
    const { result } = renderHook(() => useRun(), { wrapper });

    act(() =>
      result.current.showBlocker(APP_A, {
        kind: "missing-config",
        entries: [{ name: "region", envVar: "REGION", secret: false }],
      }),
    );

    expect(result.current.blockerForApp(APP_A)?.kind).toBe("missing-config");
    expect(result.current.blockerForApp(APP_B)).toBeNull();
    // A blocker is what opens the dock — it answers "what happened when I
    // pressed Run" in the same place the output would have gone.
    expect(result.current.dockForApp(APP_A).open).toBe(true);

    act(() => result.current.clearBlocker(APP_A));
    expect(result.current.blockerForApp(APP_A)).toBeNull();
  });

  it("keeps a run live while another app is run", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    await bound(() => result.current);

    await runApp(() => result.current, APP_A);
    await runApp(() => result.current, APP_B);

    await waitFor(() => expect(result.current.liveRunForApp(APP_B)?.runId).toBe("run-2"));
    expect(result.current.liveRunForApp(APP_A)?.runId).toBe("run-1");
  });

  it("reads a run Stop ended as stopped", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const { fake } = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    const run = result.current.liveRunForApp(APP_A)!;

    await act(async () => {
      await result.current.stopRun(run.id);
    });

    expect(fake.stopCalls).toEqual(["a"]);
    expect(result.current.runsForApp(APP_A)[0]?.status).toEqual({ kind: "stopped" });
  });
});

describe("an Application that no longer exists", () => {
  beforeEach(() => localStorage.clear());

  it("has its live run stopped and its runs dropped, leaving the other app's alone", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const { fake } = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    await runApp(() => result.current, APP_B);
    await waitFor(() => expect(result.current.liveRunForApp(APP_A)?.status.kind).toBe("running"));

    await act(async () => {
      result.current.forgetApp(APP_A);
    });

    // A run left going for a deleted app is a process nothing in the editor
    // can reach.
    expect(fake.stopCalls).toEqual(["a"]);
    expect(result.current.runsForApp(APP_A)).toEqual([]);
    expect(result.current.liveRunForApp(APP_A)).toBeNull();
    expect(result.current.dockForApp(APP_A).open).toBe(false);
    expect(result.current.liveRunForApp(APP_B)?.runId).toBe("run-2");
  });
});

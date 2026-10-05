import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { RunProvider, useRun } from "../context";
import type { RunAdapter, RunEvent, RunRequest, RunSession, RunStatus } from "../types";

const APP_A = "/workspace/a/telo.yaml";
const APP_B = "/workspace/b/telo.yaml";

function wrapper({ children }: { children: ReactNode }) {
  return <RunProvider>{children}</RunProvider>;
}

/** A session the test drives directly: no runner, no transport — only the
 *  status transitions the context keys its per-app state on. */
function fakeAdapter(sessionId: string): {
  adapter: RunAdapter<unknown>;
  emit: (event: RunEvent) => void;
} {
  let status: RunStatus = { kind: "starting" };
  const listeners = new Set<(event: RunEvent) => void>();
  const session: RunSession = {
    id: sessionId,
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: async () => {
      status = { kind: "stopped" };
      for (const listener of listeners) listener({ type: "status", status });
    },
  };
  const adapter = {
    id: "fake",
    displayName: "Fake runner",
    description: "",
    configSchema: {},
    defaultConfig: {},
    validateConfig: () => [],
    isAvailable: async () => ({ status: "ready" }) as const,
    start: async (_request: RunRequest) => session,
  } as unknown as RunAdapter<unknown>;
  return {
    adapter,
    emit: (event) => {
      if (event.type === "status") status = event.status;
      for (const listener of listeners) listener(event);
    },
  };
}

const request: RunRequest = {
  bundle: { entryRelativePath: "telo.yaml", files: [] },
};

async function start(
  run: ReturnType<typeof useRun>,
  appPath: string,
  adapter: RunAdapter<unknown>,
): Promise<void> {
  await act(async () => {
    await run.startRun({ appPath, adapter, config: {}, request });
  });
}

describe("run state is keyed by Application", () => {
  beforeEach(() => localStorage.clear());

  it("opens only the started app's dock, and leaves the other app's closed", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const { adapter } = fakeAdapter("run-1");

    expect(result.current.dockForApp(APP_A).open).toBe(false);
    await start(result.current, APP_A, adapter);

    expect(result.current.dockForApp(APP_A).open).toBe(true);
    expect(result.current.dockForApp(APP_B).open).toBe(false);
  });

  it("keeps each app's dock height independent", async () => {
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
    const { adapter } = fakeAdapter("run-1");

    await start(result.current, APP_A, adapter);

    expect(result.current.selectedRunForApp(APP_A)?.id).toBe("run-1");
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

  it("keeps a run live while another app is started", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const first = fakeAdapter("run-a");
    const second = fakeAdapter("run-b");

    await start(result.current, APP_A, first.adapter);
    act(() => first.emit({ type: "status", status: { kind: "running" } }));
    await start(result.current, APP_B, second.adapter);

    expect(result.current.liveRunForApp(APP_A)?.id).toBe("run-a");
    expect(result.current.liveRunForApp(APP_B)?.id).toBe("run-b");
  });
});

describe("an Application that no longer exists", () => {
  beforeEach(() => localStorage.clear());

  it("has its running session stopped and its runs dropped, leaving the other app's alone", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const a = fakeAdapter("run-a");
    const b = fakeAdapter("run-b");
    await start(result.current, APP_A, a.adapter);
    await start(result.current, APP_B, b.adapter);
    act(() => a.emit({ type: "status", status: { kind: "running" } }));
    act(() => b.emit({ type: "status", status: { kind: "running" } }));
    const stopped: string[] = [];
    const sessionA = result.current.runsForApp(APP_A)[0]!;
    expect(sessionA.status.kind).toBe("running");

    // The stop arrives through the session's own status stream.
    const unsubscribe = (await a.adapter.start(request, {})).subscribe((event) => {
      if (event.type === "status") stopped.push(event.status.kind);
    });

    await act(async () => {
      result.current.forgetApp(APP_A);
    });
    unsubscribe();

    // A session left running for a deleted app is a workload nothing in the
    // editor can reach, and every later save would try to sync into it.
    expect(stopped).toEqual(["stopped"]);
    expect(result.current.runsForApp(APP_A)).toEqual([]);
    expect(result.current.liveRunForApp(APP_A)).toBeNull();
    expect(result.current.dockForApp(APP_A).open).toBe(false);
    expect(result.current.liveRunForApp(APP_B)?.id).toBe("run-b");
  });
});

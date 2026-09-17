import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunProvider, useRun } from "../context";
import { registry } from "../registry";
import { saveRunIndex } from "../run-index";
import type { RunAdapter, RunStatus } from "../types";

/**
 * A run record OUTLIVES the live session object behind it — it is persisted
 * across a page reload, and the runner holds its registry in memory, so a
 * restart forgets every session. These cover the consequence: a record left
 * claiming to be live is one the editor can neither stop nor replace, because
 * the same claim hides the Run button behind a Stop that had nothing to act on.
 */

const APP = "/workspace/a/telo.yaml";
const ADAPTER_ID = "fake";
const RUN_ID = "run-1";

function wrapper({ children }: { children: ReactNode }) {
  return <RunProvider>{children}</RunProvider>;
}

/** Seed the persisted index as a previous page would have left it, then build a
 *  provider over an adapter answering the way the scenario says the runner does. */
function givenRestoredRun(
  status: RunStatus,
  answers: {
    probeSession?: RunAdapter<unknown>["probeSession"];
    stopSession?: RunAdapter<unknown>["stopSession"];
    attach?: RunAdapter<unknown>["attach"];
  },
) {
  saveRunIndex([
    {
      id: RUN_ID,
      appPath: APP,
      adapterId: ADAPTER_ID,
      adapterDisplayName: "Fake runner",
      hasTerminal: false,
      startedAt: Date.now(),
      status,
      config: { baseUrl: "http://runner.test" },
    },
  ]);
  registry.register({
    id: ADAPTER_ID,
    displayName: "Fake runner",
    description: "",
    configSchema: {},
    defaultConfig: {},
    validateConfig: () => [],
    isAvailable: async () => ({ status: "ready" }) as const,
    start: async () => {
      throw new Error("not used");
    },
    ...answers,
  } as unknown as RunAdapter<unknown>);

  return renderHook(() => useRun(), { wrapper });
}

/** Let the mount-time reconciliation settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  registry.clear();
  localStorage.clear();
});

describe("a run the runner has forgotten", () => {
  it("settles itself on mount, so the app can be run again", async () => {
    // The runner answers: it has no such session. That is a fact about the run,
    // not merely about our ability to show its history.
    const { result } = givenRestoredRun(
      { kind: "running" },
      { probeSession: async () => null },
    );
    await flush();

    expect(result.current.liveRunForApp(APP)).toBeNull();
    expect(result.current.runsForApp(APP)[0]?.status.kind).toBe("failed");
  });

  it("can still be stopped with no live session behind it", async () => {
    // The reconcile says nothing (an older adapter), so the record stays live —
    // this is the path where Stop used to be a silent no-op.
    const stopSession = vi.fn(async () => undefined);
    const { result } = givenRestoredRun({ kind: "running" }, { stopSession });
    await flush();

    expect(result.current.liveRunForApp(APP)?.id).toBe(RUN_ID);

    await act(async () => {
      await result.current.stopRun(RUN_ID);
    });

    expect(stopSession).toHaveBeenCalledWith(RUN_ID, { baseUrl: "http://runner.test" });
    // Settled locally: the event stream that would have reported this is exactly
    // what a runner restart takes away.
    expect(result.current.runsForApp(APP)[0]?.status.kind).toBe("stopped");
    expect(result.current.liveRunForApp(APP)).toBeNull();
  });

  it("is dropped from the app's live slot when its re-attach finds nothing", async () => {
    const { result } = givenRestoredRun(
      { kind: "running" },
      { attach: async () => null, probeSession: async () => ({ kind: "running" }) },
    );
    await flush();
    expect(result.current.liveRunForApp(APP)?.id).toBe(RUN_ID);

    await act(async () => {
      result.current.selectRun(RUN_ID);
    });
    await flush();

    expect(result.current.liveRunForApp(APP)).toBeNull();
    expect(result.current.runsForApp(APP)[0]?.historyUnavailable).toBe(true);
  });
});

describe("a run whose runner cannot be reached", () => {
  it("keeps its status rather than reporting an outage as a finished run", async () => {
    const { result } = givenRestoredRun(
      { kind: "running" },
      {
        probeSession: async () => {
          throw new Error("Couldn't reach the runner at http://runner.test.");
        },
      },
    );
    await flush();

    // Nothing was learned about the workload, so nothing is asserted about it.
    expect(result.current.runsForApp(APP)[0]?.status.kind).toBe("running");
  });

  it("reports a failed stop instead of silently doing nothing", async () => {
    const { result } = givenRestoredRun(
      { kind: "running" },
      {
        stopSession: async () => {
          throw new Error("Couldn't reach the runner at http://runner.test.");
        },
      },
    );
    await flush();

    await act(async () => {
      await result.current.stopRun(RUN_ID);
    });

    // The status is untouched — the stop genuinely did not happen — and the
    // record is still there for the toast's "Forget run" to remove.
    expect(result.current.runsForApp(APP)[0]?.status.kind).toBe("running");

    act(() => result.current.removeRun(RUN_ID));
    expect(result.current.runsForApp(APP)).toHaveLength(0);
  });
});

describe("a run the runner still has", () => {
  it("keeps the status the runner reports, not the one the page remembered", async () => {
    // It finished while the tab was closed: the remembered `running` is stale.
    const { result } = givenRestoredRun(
      { kind: "running" },
      { probeSession: async () => ({ kind: "exited", code: 0 }) },
    );
    await flush();

    expect(result.current.runsForApp(APP)[0]?.status).toEqual({ kind: "exited", code: 0 });
    expect(result.current.liveRunForApp(APP)).toBeNull();
  });

  it("stays live when the runner says so", async () => {
    const { result } = givenRestoredRun(
      { kind: "running" },
      { probeSession: async () => ({ kind: "running" }) },
    );
    await flush();

    expect(result.current.liveRunForApp(APP)?.id).toBe(RUN_ID);
  });
});

describe("a suspended session", () => {
  it("survives a reload, so it can still be named and stopped", async () => {
    // Omitting `suspended` from the persisted index dropped the entry entirely,
    // leaving a session on the runner the editor could no longer address.
    const stopSession = vi.fn(async () => undefined);
    const { result } = givenRestoredRun({ kind: "suspended" }, { stopSession });
    await flush();

    expect(result.current.runsForApp(APP)).toHaveLength(1);

    await act(async () => {
      await result.current.stopRun(RUN_ID);
    });
    expect(stopSession).toHaveBeenCalled();
  });
});

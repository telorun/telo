import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openExternal } from "../../external-link";
import { setAlwaysOpen } from "../open-app-preference";
import { openWithoutGesture } from "../open-url-launch";
import { RunProvider, useRun, type WorkspaceBinding } from "../context";
import type { RunEvent } from "../types";
import { FakeRunner, emptyBridge, memoryResumeSecretStore, type FakeSession } from "./fake-runner";

vi.mock("../../external-link", () => ({ openExternal: vi.fn(async () => undefined) }));
vi.mock("../open-url-launch", () => ({ openWithoutGesture: vi.fn(async () => true) }));

const APP_A = "/workspace/a/telo.yaml";
const APP_B = "/workspace/b/telo.yaml";

function wrapper({ children }: { children: ReactNode }) {
  return <RunProvider>{children}</RunProvider>;
}

async function bound(run: () => ReturnType<typeof useRun>): Promise<FakeSession> {
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
  return fake;
}

async function runApp(run: () => ReturnType<typeof useRun>, appPath: string) {
  await act(async () => {
    await run().runApp(appPath, { env: {}, io: "tty" });
  });
  await waitFor(() => expect(run().liveRunForApp(appPath)?.status.kind).toBe("running"));
}

const endpoint: RunEvent = { type: "endpoints", app: "a", added: [{ host: "", port: 3000, protocol: "tcp" }] };
const portRequest: RunEvent = { type: "openUrl", app: "a", generation: 1, url: "http://localhost:3000/x", reach: "port", port: 3000 };

describe("open requests from an app", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(openExternal).mockClear();
    vi.mocked(openWithoutGesture).mockClear();
    vi.mocked(openWithoutGesture).mockResolvedValue(true);
  });

  it("asks once about a port address of a run this page started, and a new run asks again", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);

    act(() => {
      fake.emit(endpoint);
      fake.emit(portRequest);
      fake.emit(portRequest);
    });
    expect(result.current.openUrlRequests).toHaveLength(1);
    expect(result.current.openUrlRequests[0]).toMatchObject({ mode: "confirm", app: "a", address: "http://runner.test:3000/x" });

    await act(async () => {
      await result.current.stopRun(result.current.liveRunForApp(APP_A)!.id);
    });
    await runApp(() => result.current, APP_A);
    act(() => {
      fake.emit(endpoint);
      fake.emit(portRequest);
    });
    expect(result.current.openUrlRequests).toHaveLength(1);
    expect(result.current.openUrlRequests[0]!.recordId).toBe(result.current.liveRunForApp(APP_A)!.id);
  });

  it("waits for the endpoint when it arrives after the request", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);

    act(() => fake.emit(portRequest));
    expect(result.current.openUrlRequests).toEqual([]);

    act(() => fake.emit(endpoint));
    expect(result.current.openUrlRequests).toHaveLength(1);
  });

  it("shows an unrouted address and never opens it, and asks about an external one with its host", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);

    act(() => {
      fake.emit({ type: "openUrl", app: "a", generation: 1, url: "http://localhost:9/", reach: "unrouted", port: 9 });
      fake.emit({ type: "openUrl", app: "a", generation: 1, url: "https://example.org/p", reach: "external" });
      fake.emit({ type: "mystery", app: "a" } as unknown as RunEvent);
    });

    expect(result.current.openUrlRequests.map((r) => [r.reach, r.mode, r.host])).toEqual([
      ["unrouted", "notice", "localhost:9"],
      ["external", "confirm", "example.org"],
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("shows a notice, not a question, for a run this page did not start", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);

    act(() => {
      fake.emit({ type: "app", app: "a", state: "running", runId: "other" });
      fake.emit(endpoint);
      fake.emit(portRequest);
    });

    expect(result.current.openUrlRequests.map((r) => r.mode)).toEqual(["notice"]);
  });

  it("drops a request whose run already ended", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    act(() => fake.emit(endpoint));
    await act(async () => {
      await result.current.stopRun(result.current.liveRunForApp(APP_A)!.id);
    });

    act(() => fake.emit(portRequest));

    expect(result.current.openUrlRequests).toEqual([]);
  });

  it("opens at once for an app answered 'always' in this workspace, and still asks for another app", async () => {
    setAlwaysOpen("/workspace", "a");
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    await runApp(() => result.current, APP_B);

    act(() => {
      fake.emit(endpoint);
      fake.emit(portRequest);
      fake.emit({ type: "endpoints", app: "b", added: [{ host: "", port: 3001, protocol: "tcp" }] });
      fake.emit({ type: "openUrl", app: "b", generation: 1, url: "http://localhost:3001/", reach: "port", port: 3001 });
    });

    expect(openWithoutGesture).toHaveBeenCalledOnce();
    expect(openWithoutGesture).toHaveBeenCalledWith("http://runner.test:3000/x");
    expect(result.current.openUrlRequests.map((r) => r.app)).toEqual(["b"]);
  });

  it("falls back to the dialog when the browser blocks an automatic open", async () => {
    setAlwaysOpen("/workspace", "a");
    vi.mocked(openWithoutGesture).mockResolvedValue(false);
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);

    act(() => {
      fake.emit(endpoint);
      fake.emit(portRequest);
    });

    await waitFor(() => expect(result.current.openUrlRequests.map((r) => r.mode)).toEqual(["confirm"]));
  });

  it("opens on Open, remembers 'always' for a port address, and records nothing on Not now", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    act(() => {
      fake.emit(endpoint);
      fake.emit(portRequest);
    });

    act(() => result.current.answerOpenUrl(result.current.openUrlRequests[0]!.id, { open: false, always: true }));
    expect(openExternal).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);

    act(() => fake.emit({ ...portRequest, url: "http://localhost:3000/y" } as RunEvent));
    act(() => result.current.answerOpenUrl(result.current.openUrlRequests[0]!.id, { open: true, always: true }));
    expect(openExternal).toHaveBeenCalledWith("http://runner.test:3000/y");
    expect(localStorage.length).toBe(1);
  });

  it("resolves a port request against another app's endpoint", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);
    await runApp(() => result.current, APP_B);

    act(() => {
      fake.emit({ type: "openUrl", app: "a", generation: 1, url: "http://localhost:3001/docs/", reach: "port", port: 3001 });
      fake.emit({ type: "endpoints", app: "b", added: [{ host: "", port: 3001, protocol: "tcp" }] });
    });

    expect(result.current.openUrlRequests).toHaveLength(1);
    expect(result.current.openUrlRequests[0]).toMatchObject({ mode: "confirm", app: "a", address: "http://runner.test:3001/docs/" });
  });

  it("keeps only the newest 16 notices of a run", async () => {
    const { result } = renderHook(() => useRun(), { wrapper });
    const fake = await bound(() => result.current);
    await runApp(() => result.current, APP_A);

    act(() => {
      for (let i = 0; i < 20; i++) {
        fake.emit({ type: "openUrl", app: "a", generation: i, url: `http://localhost:9/${i}`, reach: "unrouted", port: 9 });
      }
    });

    const addresses = result.current.openUrlRequests.map((r) => r.address);
    expect(addresses).toHaveLength(16);
    expect(addresses[0]).toBe("http://localhost:9/4");
    expect(addresses[15]).toBe("http://localhost:9/19");
  });
});

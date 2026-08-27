import { describe, expect, it, vi } from "vitest";

import { reapOrphanContainers, type ListedContainer } from "./reap-orphans.js";

const log = { info: vi.fn(), warn: vi.fn() };

function fakeDocker(containers: ListedContainer[], removed: string[]) {
  return {
    listContainers: async () => containers,
    getContainer: (name: string) => ({
      remove: async () => {
        removed.push(name);
      },
    }),
  };
}

describe("reapOrphanContainers", () => {
  it("removes every container of a previous runner's sessions", async () => {
    // A watch session's containers outlive their runs by design, so a restart
    // leaves the workspace, the agent and every app running with nothing able to
    // reach them — the session registry is in memory.
    const removed: string[] = [];
    await reapOrphanContainers(
      fakeDocker(
        [
          { Names: ["/telo-run-abc-workspace"] },
          { Names: ["/telo-run-abc-app-web"] },
          { Names: ["/telo-run-abc-agent"] },
        ],
        removed,
      ),
      log,
    );
    expect(removed.sort()).toEqual([
      "telo-run-abc-agent",
      "telo-run-abc-app-web",
      "telo-run-abc-workspace",
    ]);
  });

  it("leaves containers that are not sessions alone", async () => {
    const removed: string[] = [];
    await reapOrphanContainers(
      fakeDocker([{ Names: ["/telo-runner-1"] }, { Names: ["/postgres"] }], removed),
      log,
    );
    expect(removed).toEqual([]);
  });

  it("keeps going when one removal fails", async () => {
    const removed: string[] = [];
    const docker = {
      listContainers: async () => [
        { Names: ["/telo-run-a-workspace"] },
        { Names: ["/telo-run-b-workspace"] },
      ],
      getContainer: (name: string) => ({
        remove: async () => {
          if (name.includes("-a-")) throw new Error("daemon said no");
          removed.push(name);
        },
      }),
    };
    await reapOrphanContainers(docker, log);
    expect(removed).toEqual(["telo-run-b-workspace"]);
  });

  it("treats an unreachable daemon as nothing to do", async () => {
    // The boot-state check already reports an unreachable daemon; reporting it
    // twice from here would not tell anyone anything new.
    const docker = {
      listContainers: async () => {
        throw new Error("daemon unreachable");
      },
      getContainer: () => ({ remove: async () => undefined }),
    };
    await expect(reapOrphanContainers(docker, log)).resolves.toBeUndefined();
  });
});

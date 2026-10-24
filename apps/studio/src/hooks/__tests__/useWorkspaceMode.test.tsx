import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { saveWorkspaceSessionEntry } from "../../run/workspace-session-entry";
import { useWorkspaceMode } from "../useWorkspaceMode";

describe("the open workspace's mode", () => {
  beforeEach(() => localStorage.clear());

  it("is never the previous workspace's while a switch is committed", () => {
    saveWorkspaceSessionEntry("/a", { mode: "agent", workspace: "device:a" });
    saveWorkspaceSessionEntry("/b", { mode: "device", workspace: "device:b" });
    const seen: Array<[string, unknown]> = [];
    const { rerender } = renderHook(
      ({ root }) => {
        const { workspaceMode } = useWorkspaceMode(root);
        seen.push([root, workspaceMode]);
        return workspaceMode;
      },
      { initialProps: { root: "/a" } },
    );
    expect(seen.at(-1)).toEqual(["/a", "agent"]);

    seen.length = 0;
    rerender({ root: "/b" });

    expect(seen.map(([, mode]) => mode)).not.toContain("agent");
    // Not read yet is not "undecided", so the mode dialog does not open for it.
    expect(seen.map(([, mode]) => mode)).not.toContain(null);
    expect(seen.at(-1)).toEqual(["/b", "device"]);
  });
});

import { describe, expect, it } from "vitest";

import { sessionUnavailableReason } from "../ui/SessionStatusChip";
import type { WorkspaceSessionState } from "../workspace-session";

function session(patch: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { phase: "live", problem: null, status: null, ...patch } as WorkspaceSessionState;
}

describe("why a workspace's session cannot run an application", () => {
  it("is the failure to bring the session up, when the phase failed", () => {
    expect(sessionUnavailableReason(session({ phase: "failed", problem: "runner unreachable" }))).toBe("runner unreachable");
  });

  it("is the session's own failure message, when the runner reports the session failed", () => {
    expect(sessionUnavailableReason(session({ status: { kind: "failed", message: "image pull refused" } }))).toBe(
      "image pull refused",
    );
  });

  it("is null while the session can run", () => {
    expect(sessionUnavailableReason(session({ status: { kind: "running" } }))).toBeNull();
    expect(sessionUnavailableReason(session({ status: { kind: "suspended" } }))).toBeNull();
  });
});

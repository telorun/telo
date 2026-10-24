import { beforeEach, describe, expect, it } from "vitest";

import { LOCAL_PREFIXES } from "../../storage-keys";
import {
  entryResumeSecretStore,
  forgetIdentitySessions,
  loadWorkspaceSessionEntry,
  newWorkspaceSessionEntry,
  saveWorkspaceSessionEntry,
} from "../workspace-session-entry";

beforeEach(() => localStorage.clear());

describe("a workspace's session entry", () => {
  it("is kept per workspace under telo-studio:session:v1:<workspaceKey>", () => {
    saveWorkspaceSessionEntry("/ws", { mode: "manual", workspace: "device:x", runner: "r1", sessionId: "s1" });
    expect(JSON.parse(localStorage.getItem(`${LOCAL_PREFIXES.session}/ws`)!)).toEqual({
      mode: "manual",
      workspace: "device:x",
      runner: "r1",
      sessionId: "s1",
    });
    expect(loadWorkspaceSessionEntry("/ws")?.mode).toBe("manual");
    expect(loadWorkspaceSessionEntry("/other")).toBeNull();
  });

  it("reads a value this build did not write as no entry", () => {
    for (const raw of ["{", "null", JSON.stringify({ mode: "cloud", workspace: "w" }), JSON.stringify({ mode: "agent" }), JSON.stringify({ mode: "agent", workspace: "w", sessionId: 3 })]) {
      localStorage.setItem(`${LOCAL_PREFIXES.session}/ws`, raw);
      expect(loadWorkspaceSessionEntry("/ws")).toBeNull();
    }
  });

  it("names a session by the Telo Cloud project, else by an id minted on this device", () => {
    expect(newWorkspaceSessionEntry("agent", "p-42")).toEqual({ mode: "agent", workspace: "p-42" });
    const local = newWorkspaceSessionEntry("device", null);
    expect(local.workspace).toMatch(/^device:[0-9a-f-]{36}$/);
    expect(newWorkspaceSessionEntry("device", null).workspace).not.toBe(local.workspace);
  });

  it("holds the web build's resume secret for the entry's runner, removed with a null", async () => {
    saveWorkspaceSessionEntry("/ws", { mode: "agent", workspace: "w", runner: "r1", sessionId: "s1" });
    const store = entryResumeSecretStore();
    const scope = { runner: "r1", workspaceKey: "/ws" };
    await store.write(scope, "sekret");
    expect(await store.read(scope)).toBe("sekret");
    expect(await store.read({ runner: "r2", workspaceKey: "/ws" })).toBeNull();
    expect(loadWorkspaceSessionEntry("/ws")).toEqual({
      mode: "agent",
      workspace: "w",
      runner: "r1",
      sessionId: "s1",
      resumeSecret: "sekret",
    });
    await store.write(scope, null);
    expect(loadWorkspaceSessionEntry("/ws")).toEqual({ mode: "agent", workspace: "w", runner: "r1", sessionId: "s1" });
  });

  it("forgets the identity's sessions on sign-out and keeps resume-secret ones", () => {
    saveWorkspaceSessionEntry("/a", { mode: "agent", workspace: "p-1", runner: "r1", sessionId: "s1", owner: "identity" });
    saveWorkspaceSessionEntry("/b", { mode: "manual", workspace: "device:2", runner: "r1", sessionId: "s2", resumeSecret: "k" });
    forgetIdentitySessions();
    expect(loadWorkspaceSessionEntry("/a")).toEqual({ mode: "agent", workspace: "p-1", runner: "r1" });
    expect(loadWorkspaceSessionEntry("/b")).toEqual({
      mode: "manual",
      workspace: "device:2",
      runner: "r1",
      sessionId: "s2",
      resumeSecret: "k",
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_STATE } from "../editor-state";
import type { Workspace } from "../model";
import {
  forgetWorkspaceRoot,
  loadPersistedState,
  recordWorkspaceBackend,
  saveState,
} from "../storage";
import { LOCAL_KEYS } from "../storage-keys";
import { recentWorkspaceLabel, restoreDecision } from "./workspace-restore";

const open = { ...INITIAL_STATE, workspace: { rootDir: "/workspace" } as Workspace };

beforeEach(() => window.localStorage.clear());

describe("the persisted backend", () => {
  it("is recorded with the open workspace and read back", () => {
    recordWorkspaceBackend("browser");
    saveState(open);
    expect(loadPersistedState()).toMatchObject({ rootDir: "/workspace", backend: "browser" });
  });

  it("is absent in a hint written before it was recorded", () => {
    window.localStorage.setItem(
      LOCAL_KEYS.uiState,
      JSON.stringify({ rootDir: "/workspace", activeModulePath: null }),
    );
    const hint = loadPersistedState();
    expect(hint?.rootDir).toBe("/workspace");
    expect(hint?.backend).toBeUndefined();
  });

  it("is dropped when the user closes the workspace", () => {
    recordWorkspaceBackend("browser");
    saveState(open);
    forgetWorkspaceRoot();
    expect(loadPersistedState()?.backend).toBeUndefined();
  });
});

describe("restoring a hint", () => {
  it("opens a browser-stored workspace by its backend", () => {
    expect(restoreDecision({ rootDir: "/workspace", backend: "browser" })).toBe("browser");
  });

  it("opens an old hint and a picked folder by their root", () => {
    expect(restoreDecision({ rootDir: "/workspace" })).toBe("root");
    expect(restoreDecision({ rootDir: "/workspace", backend: "folder" })).toBe("root");
  });

  it("opens nothing without a root", () => {
    expect(restoreDecision({ rootDir: null, backend: "browser" })).toBe("none");
    expect(restoreDecision(null)).toBe("none");
  });

  it("labels the browser workspace by name and a folder by its name", () => {
    expect(recentWorkspaceLabel({ rootDir: "/workspace", backend: "browser" })).toBe(
      "Browser workspace",
    );
    expect(recentWorkspaceLabel({ rootDir: "/my-app", backend: "folder" })).toBe("my-app");
  });
});

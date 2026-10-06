import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_STATE } from "./editor-state";
import type { Workspace } from "./model";
import { forgetWorkspaceRoot, loadPersistedState, saveState } from "./storage";
import { LOCAL_PREFIXES } from "./storage-keys";

/** A closed workspace stays closed across a reload. Two things pull the other
 *  way and both are deliberate: a workspace-less state keeps the last root, and
 *  a browser-stored workspace is found again by its files. */

const open = { ...INITIAL_STATE, workspace: { rootDir: "/workspace" } as Workspace };

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(`${LOCAL_PREFIXES.workspace}/workspace/apps/demo/telo.yaml`, "x");
});

describe("closing a workspace", () => {
  it("is reopened on reload while it was merely left open", () => {
    saveState(open);
    expect(loadPersistedState()?.rootDir).toBe("/workspace");
  });

  it("is found by its files when no root was ever recorded", () => {
    expect(loadPersistedState()?.rootDir).toBe("/workspace");
  });

  it("is not reopened after the user closed it", () => {
    saveState(open);
    forgetWorkspaceRoot();
    expect(loadPersistedState()?.rootDir).toBeNull();
  });

  it("stays closed through the workspace-less save that follows the close", () => {
    saveState(open);
    forgetWorkspaceRoot();
    saveState(INITIAL_STATE);
    expect(loadPersistedState()?.rootDir).toBeNull();
  });

  it("is reopened again once the user opens it after a close", () => {
    forgetWorkspaceRoot();
    saveState(open);
    saveState(INITIAL_STATE);
    expect(loadPersistedState()?.rootDir).toBe("/workspace");
  });
});

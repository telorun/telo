// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { LOCAL_KEYS } from "../../storage-keys";
import {
  findWorkingCopy,
  forgetOrphanedWorkingCopy,
  loadOrphanedWorkingCopies,
  loadWorkingCopyIndex,
  putWorkingCopy,
  type WorkingCopyEntry,
} from "../working-copy-index";

const CURRENT: WorkingCopyEntry = {
  userId: "usr_1",
  orgId: "org_1",
  projectId: "prj_1",
  projectName: "Shop",
  role: "admin",
  branch: "main",
  baseCommit: "c1",
};

/** An entry as it was stored while Cloud called a project a workspace. */
const ORPHANED = {
  userId: "usr_1",
  orgId: "org_1",
  workspaceId: "wks_9",
  workspaceName: "Old shop",
  role: "admin",
  branch: "main",
  baseCommit: "c0",
};

describe("working-copy index", () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCAL_KEYS.cloudWorkingCopies, JSON.stringify([ORPHANED]));
  });

  it("does not list an entry stored under the old name as a working copy", () => {
    expect(loadWorkingCopyIndex()).toEqual([]);
    expect(findWorkingCopy("wks_9")).toBeNull();
    expect(loadOrphanedWorkingCopies()).toEqual([{ id: "wks_9", name: "Old shop" }]);
  });

  it("keeps an orphaned entry when a working copy is written", () => {
    putWorkingCopy(CURRENT);
    expect(loadWorkingCopyIndex()).toEqual([CURRENT]);
    expect(loadOrphanedWorkingCopies()).toEqual([{ id: "wks_9", name: "Old shop" }]);
  });

  it("forgets an orphaned entry and nothing else", () => {
    putWorkingCopy(CURRENT);
    forgetOrphanedWorkingCopy("wks_9");
    expect(loadOrphanedWorkingCopies()).toEqual([]);
    expect(loadWorkingCopyIndex()).toEqual([CURRENT]);
  });
});

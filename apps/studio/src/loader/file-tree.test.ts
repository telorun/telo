import { describe, expect, it } from "vitest";

import type { DirEntry, WorkspaceAdapter } from "../model";
import { buildFileTree } from "./file-tree";

// Lists the directories a fake workspace holds: a path is a directory when it is
// a key of `dirs`, and its entries are the files and directories directly under it.
function adapterWith(dirs: Record<string, DirEntry[]>): WorkspaceAdapter {
  return {
    listDir: async (path: string) => {
      const entries = dirs[path];
      if (!entries) throw new Error(`not a directory: ${path}`);
      return entries;
    },
  } as unknown as WorkspaceAdapter;
}

describe("buildFileTree", () => {
  it("shows an empty folder as a directory with no children", async () => {
    const adapter = adapterWith({
      "/ws": [{ name: "empty", isDirectory: true, kind: "directory" }],
      "/ws/empty": [],
    });

    const tree = await buildFileTree("/ws", adapter);

    expect(tree).toEqual([{ name: "empty", path: "/ws/empty", isDirectory: true, children: [] }]);
  });
});

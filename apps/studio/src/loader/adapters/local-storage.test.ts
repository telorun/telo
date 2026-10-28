import { afterEach, describe, expect, it } from "vitest";

import { LocalStorageAdapter } from "./local-storage";

const ROOT = "/ws";

afterEach(() => {
  localStorage.clear();
});

describe("LocalStorageAdapter", () => {
  it("lists a folder created with no files in it", async () => {
    const adapter = new LocalStorageAdapter(ROOT);

    await adapter.createDir("/ws/docs");

    expect(await adapter.listDir(ROOT)).toEqual([{ name: "docs", isDirectory: true, kind: "directory" }]);
  });

  it("lists a folder inside an empty folder under its parent", async () => {
    const adapter = new LocalStorageAdapter(ROOT);

    await adapter.createDir("/ws/a/b");

    expect(await adapter.listDir(ROOT)).toEqual([{ name: "a", isDirectory: true, kind: "directory" }]);
    expect(await adapter.listDir("/ws/a")).toEqual([{ name: "b", isDirectory: true, kind: "directory" }]);
  });

  it("removes an empty folder on delete", async () => {
    const adapter = new LocalStorageAdapter(ROOT);
    await adapter.createDir("/ws/docs");

    await adapter.delete("/ws/docs");

    expect(await adapter.listDir(ROOT)).toEqual([]);
  });

  it("moves an empty folder on rename", async () => {
    const adapter = new LocalStorageAdapter(ROOT);
    await adapter.createDir("/ws/docs");

    await adapter.rename("/ws/docs", "/ws/guides");

    expect(await adapter.listDir(ROOT)).toEqual([{ name: "guides", isDirectory: true, kind: "directory" }]);
  });
});

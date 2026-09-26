import { afterEach, expect, it } from "vitest";
import { DirectoryNotFoundError } from "../../loader/adapters/directory-not-found";
import type { DirEntry, WorkspaceAdapter } from "../../model";
import { LocalStorageAdapter } from "../../loader/adapters/local-storage";
import { WorkspaceFileSystem } from "../workspace-file-system";

afterEach(() => window.localStorage.clear());

it("serves a browser workspace by its file: URIs, and nothing outside its root", async () => {
  const adapter = new LocalStorageAdapter("/workspace");
  await adapter.writeFile("/workspace/app/telo.yaml", "kind: Telo.Application\n");
  const files = new WorkspaceFileSystem(() => adapter, "/workspace");

  expect(await files.stat("file:///workspace/app")).toBe("directory");
  expect(await files.stat("file:///workspace/app/telo.yaml")).toBe("file");
  expect(await files.stat("file:///workspace/app/missing.yaml")).toBeUndefined();
  expect(await files.stat("file:///telo.yaml")).toBeUndefined();
  expect(await files.readText("file:///workspace/app/telo.yaml")).toBe("kind: Telo.Application\n");
  expect(await files.readDirectory("file:///workspace")).toEqual([{ name: "app", kind: "directory" }]);
});

it("follows a link when asked what a path is, and lists the link itself as a link", async () => {
  const listings: Record<string, DirEntry[]> = {
    "/ws": [
      { name: "shared", isDirectory: false, kind: "symlink" },
      { name: "routes.yaml", isDirectory: false, kind: "symlink" },
    ],
    "/ws/shared": [{ name: "telo.yaml", isDirectory: false, kind: "file" }],
  };
  const adapter: WorkspaceAdapter = {
    readFile: async () => "",
    writeFile: async () => undefined,
    listDir: async (path) => {
      const entries = listings[path];
      if (!entries) throw new DirectoryNotFoundError(path);
      return entries;
    },
    createDir: async () => undefined,
    delete: async () => undefined,
    rename: async () => undefined,
  };
  const files = new WorkspaceFileSystem(() => adapter);
  expect(await files.stat("file:///ws/shared")).toBe("directory");
  expect(await files.stat("file:///ws/routes.yaml")).toBe("file");
  expect(await files.readDirectory("file:///ws")).toEqual([
    { name: "shared", kind: "symlink" },
    { name: "routes.yaml", kind: "symlink" },
  ]);
});

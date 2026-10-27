// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { browserWorkspaceHasFiles } from "../../storage";
import { LOCAL_PREFIXES } from "../../storage-keys";
import {
  browserWorkspaceKeptFiles,
  filesDigest,
  readBrowserWorkspaceFiles,
  removeBrowserWorkspaceFiles,
} from "../browser-workspace-files";
import { text } from "./memory-byte-store";

const put = (path: string, content: string) =>
  window.localStorage.setItem(`${LOCAL_PREFIXES.workspace}/workspace/${path}`, content);

describe("browser workspace files", () => {
  beforeEach(() => {
    window.localStorage.clear();
    put("apps/shop/telo.yaml", "kind: Telo.Application\n");
    put("README.md", "# Shop\n");
    put(".telo/manifests/cache.json", "{}");
    put("apps/shop/node_modules/x/index.js", "");
    put("apps/shop/dist/out.js", "");
    window.localStorage.setItem(`${LOCAL_PREFIXES.history}/workspace`, "{}");
  });

  it("reads the files by relative path, without what a repository should not hold", async () => {
    const files = await readBrowserWorkspaceFiles();
    expect(files.map((f) => f.path)).toEqual(["apps/shop/telo.yaml", "README.md"]);
    expect(text(files[0]!.bytes)).toBe("kind: Telo.Application\n");
  });

  it("leaves out each env file the nearest marker marks sensitive", async () => {
    put(".env.local", "TOKEN=root\n");
    put("apps/shop/telo-workspace.yaml", "env:\n  files: [.env, { name: .secrets, sensitive: true }]\n");
    put("apps/shop/.env.local", "TOKEN=shop\n");
    put("apps/shop/.secrets", "TOKEN=shop\n");
    const files = await readBrowserWorkspaceFiles();
    expect(files.map((f) => f.path)).toEqual([
      "apps/shop/.env.local",
      "apps/shop/telo-workspace.yaml",
      "apps/shop/telo.yaml",
      "README.md",
    ]);
  });

  it("refuses with the marker's message when its env block is refused", async () => {
    put("telo-workspace.yaml", "env:\n  files: [{ name: .env.local, sensitve: true }]\n");
    await expect(readBrowserWorkspaceFiles()).rejects.toThrow(/sensitve/);
  });

  it("digests paths and bytes", async () => {
    const before = await filesDigest(await readBrowserWorkspaceFiles());
    expect(await filesDigest(await readBrowserWorkspaceFiles())).toBe(before);
    put("README.md", "# Shop!\n");
    expect(await filesDigest(await readBrowserWorkspaceFiles())).not.toBe(before);
  });

  it("removes every file and nothing else when no file is sensitive", async () => {
    expect(await browserWorkspaceKeptFiles()).toEqual([]);
    await removeBrowserWorkspaceFiles();
    expect(browserWorkspaceHasFiles()).toBe(false);
    expect(window.localStorage.length).toBe(1);
  });

  it("removes the empty folders with the files", async () => {
    const folder = `${LOCAL_PREFIXES.workspaceDir}/workspace/empty`;
    window.localStorage.setItem(folder, "");
    await removeBrowserWorkspaceFiles();
    expect(window.localStorage.getItem(folder)).toBeNull();
  });

  it("keeps a sensitive file no marker governs, listed until it is deleted", async () => {
    put(".env.local", "TOKEN=root\n");
    expect(await browserWorkspaceKeptFiles()).toEqual([".env.local"]);
    await removeBrowserWorkspaceFiles();
    expect(workspacePaths()).toEqual([".env.local"]);
    expect(browserWorkspaceHasFiles()).toBe(true);
    window.localStorage.removeItem(`${LOCAL_PREFIXES.workspace}/workspace/.env.local`);
    expect(browserWorkspaceHasFiles()).toBe(false);
  });

  it("keeps the files a marker marks sensitive and the markers above them", async () => {
    put("telo-workspace.yaml", "{}\n");
    put("apps/shop/telo-workspace.yaml", "env:\n  files: [.env, { name: .secrets, sensitive: true }]\n");
    put("apps/shop/.secrets", "TOKEN=shop\n");
    put("apps/shop/.env", "PORT=1\n");
    put("apps/other/telo-workspace.yaml", "{}\n");
    const kept = ["apps/shop/.secrets", "apps/shop/telo-workspace.yaml", "telo-workspace.yaml"];
    expect(await browserWorkspaceKeptFiles()).toEqual(kept);
    await removeBrowserWorkspaceFiles();
    expect(workspacePaths()).toEqual(kept);
    expect((await readBrowserWorkspaceFiles()).map((f) => f.path)).toEqual([
      "apps/shop/telo-workspace.yaml",
      "telo-workspace.yaml",
    ]);
  });

  it("deletes nothing when a marker's env block is refused at removal", async () => {
    put(".env.local", "TOKEN=root\n");
    expect(await browserWorkspaceKeptFiles()).toEqual([".env.local"]);
    put("telo-workspace.yaml", "env:\n  files: [{ name: .env.local, sensitve: true }]\n");
    const before = workspacePaths();
    await expect(removeBrowserWorkspaceFiles()).rejects.toThrow(/sensitve/);
    expect(workspacePaths()).toEqual(before);
  });
});

function workspacePaths(): string[] {
  const prefix = `${LOCAL_PREFIXES.workspace}/workspace/`;
  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b));
}

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PREFIXES } from "../../storage-keys";
import {
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

  it("reads the files by relative path, without what a repository should not hold", () => {
    const files = readBrowserWorkspaceFiles();
    expect(files.map((f) => f.path)).toEqual(["apps/shop/telo.yaml", "README.md"]);
    expect(text(files[0]!.bytes)).toBe("kind: Telo.Application\n");
  });

  it("digests paths and bytes", async () => {
    const before = await filesDigest(readBrowserWorkspaceFiles());
    expect(await filesDigest(readBrowserWorkspaceFiles())).toBe(before);
    put("README.md", "# Shop!\n");
    expect(await filesDigest(readBrowserWorkspaceFiles())).not.toBe(before);
  });

  it("removes every file and nothing else", () => {
    removeBrowserWorkspaceFiles();
    expect(readBrowserWorkspaceFiles()).toEqual([]);
    expect(window.localStorage.length).toBe(1);
  });
});

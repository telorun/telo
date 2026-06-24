import { describe, expect, it } from "vitest";
import type { DirEntry } from "../../model";
import { selectModuleFiles } from "../select-module-files";

/** A flat path → "file" | "dir" map served as a one-level `listDir`, matching
 *  the WorkspaceAdapter contract the selector walks. */
function listDirFromTree(tree: Record<string, "file" | "dir">) {
  return async (dir: string): Promise<DirEntry[]> => {
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const seen = new Map<string, boolean>();
    for (const [path, kind] of Object.entries(tree)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, kind === "dir");
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  };
}

const BASE = "/ws/app/telo.yaml";

describe("selectModuleFiles", () => {
  it("returns nothing when no patterns are given", async () => {
    const listDir = listDirFromTree({ "/ws/app/public/a.js": "file" });
    expect(await selectModuleFiles(BASE, [], listDir)).toEqual([]);
  });

  it("matches a recursive ** glob", async () => {
    const listDir = listDirFromTree({
      "/ws/app/telo.yaml": "file",
      "/ws/app/public/a.js": "file",
      "/ws/app/public/sub/b.css": "file",
      "/ws/app/other.txt": "file",
    });
    expect(await selectModuleFiles(BASE, ["public/**"], listDir)).toEqual([
      "/ws/app/public/a.js",
      "/ws/app/public/sub/b.css",
    ]);
  });

  it("matches a bare pattern at any depth (gitignore semantics)", async () => {
    const listDir = listDirFromTree({
      "/ws/app/a.js": "file",
      "/ws/app/public/b.js": "file",
      "/ws/app/public/c.css": "file",
    });
    expect(await selectModuleFiles(BASE, ["*.js"], listDir)).toEqual([
      "/ws/app/a.js",
      "/ws/app/public/b.js",
    ]);
  });

  it("honours ! negation, last-match-wins", async () => {
    const listDir = listDirFromTree({
      "/ws/app/public/keep.js": "file",
      "/ws/app/public/skip.js": "file",
    });
    expect(await selectModuleFiles(BASE, ["public/**", "!public/skip.js"], listDir)).toEqual([
      "/ws/app/public/keep.js",
    ]);
  });

  it("ships a built frontend under dist/ (not pruned)", async () => {
    const listDir = listDirFromTree({
      "/ws/app/dist/index.html": "file",
      "/ws/app/dist/assets/app-3f9a.js": "file",
    });
    expect(await selectModuleFiles(BASE, ["dist/**"], listDir)).toEqual([
      "/ws/app/dist/assets/app-3f9a.js",
      "/ws/app/dist/index.html",
    ]);
  });

  it("never ships node_modules or the .telo cache even if a pattern matches", async () => {
    const listDir = listDirFromTree({
      "/ws/app/node_modules/dep/index.js": "file",
      "/ws/app/.telo/manifests/x/telo.yaml": "file",
      "/ws/app/public/app.js": "file",
    });
    expect(await selectModuleFiles(BASE, ["**"], listDir)).toEqual(["/ws/app/public/app.js"]);
  });
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCacheRoot } from "../src/manifest-sources/local-manifest-cache-source.js";
import { WORKSPACE_FILENAME } from "../src/workspace-marker.js";

/**
 * The `.telo` cache root's precedence: `TELO_CACHE_DIR`, then the directory
 * holding `telo-workspace.yaml`, then the entry's own directory.
 *
 * The env override is asserted rather than observed because the whole baked-image
 * story rests on it — a prebuilt image relocates its deps off the app directory
 * and mounts them read-only, and it has never resolved a workspace marker. An
 * anchor that quietly outranked the override would move every such image's cache
 * to a path its rootfs does not have.
 */

let root: string;
const saved = process.env.TELO_CACHE_DIR;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-cacheroot-")));
  delete process.env.TELO_CACHE_DIR;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.TELO_CACHE_DIR;
  else process.env.TELO_CACHE_DIR = saved;
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveCacheRoot", () => {
  it("anchors at the workspace marker, however deep the entry sits", async () => {
    await fs.writeFile(path.join(root, WORKSPACE_FILENAME), "modules: []\n");
    const deep = path.join(root, "examples", "todo-app", "tests");
    await fs.mkdir(deep, { recursive: true });

    expect(resolveCacheRoot(path.join(deep, "app.telo.yaml"))).toBe(path.join(root, ".telo"));
    expect(resolveCacheRoot(path.join(root, "app.telo.yaml"))).toBe(path.join(root, ".telo"));
  });

  it("falls back to the entry directory when no marker is above it", async () => {
    const dir = path.join(root, "loose");
    await fs.mkdir(dir, { recursive: true });

    // Deleting the marker must not break a build, so its absence has to mean
    // exactly what this did before the anchor existed.
    expect(resolveCacheRoot(path.join(dir, "app.telo.yaml"))).toBe(path.join(dir, ".telo"));
  });

  it("lets TELO_CACHE_DIR outrank the marker", async () => {
    await fs.writeFile(path.join(root, WORKSPACE_FILENAME), "modules: []\n");
    process.env.TELO_CACHE_DIR = path.join(root, "baked");

    expect(resolveCacheRoot(path.join(root, "app.telo.yaml"))).toBe(path.join(root, "baked"));
  });

  it("has no local anchor for a non-file scheme", () => {
    expect(resolveCacheRoot("https://example.com/telo.yaml")).toBeNull();
    expect(resolveCacheRoot("memory://app/telo.yaml")).toBeNull();
  });
});

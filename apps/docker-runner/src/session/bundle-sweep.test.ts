import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepOrphanBundles, type SweepDockerClient } from "./bundle-sweep.js";

const NOOP_LOG = { info: () => {}, warn: () => {} };

function makeSweepDocker(liveNames: Set<string>): SweepDockerClient {
  return {
    getContainer(name: string) {
      return {
        async inspect() {
          if (!liveNames.has(name)) {
            throw Object.assign(new Error("no such container"), { statusCode: 404 });
          }
          return { Name: name };
        },
      };
    },
  };
}

describe("sweepOrphanBundles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "docker-runner-sweep-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes dirs with no matching live container", async () => {
    await mkdir(join(root, "abc"), { recursive: true });
    await writeFile(join(root, "abc", "telo.yaml"), "x");
    await mkdir(join(root, "def"), { recursive: true });

    await sweepOrphanBundles(root, makeSweepDocker(new Set()), NOOP_LOG);

    await expect(stat(join(root, "abc"))).rejects.toThrow();
    await expect(stat(join(root, "def"))).rejects.toThrow();
  });

  it("keeps dirs whose matching container is still live", async () => {
    await mkdir(join(root, "abc"), { recursive: true });
    await mkdir(join(root, "def"), { recursive: true });

    await sweepOrphanBundles(
      root,
      makeSweepDocker(new Set(["telo-run-def"])),
      NOOP_LOG,
    );

    await expect(stat(join(root, "abc"))).rejects.toThrow();
    const s = await stat(join(root, "def"));
    expect(s.isDirectory()).toBe(true);
  });

  it("is a no-op when bundleRoot does not exist", async () => {
    await expect(
      sweepOrphanBundles(join(root, "does-not-exist"), makeSweepDocker(new Set()), NOOP_LOG),
    ).resolves.toBeUndefined();
  });

  it("skips non-directory entries", async () => {
    await writeFile(join(root, "stray.txt"), "x");
    await sweepOrphanBundles(root, makeSweepDocker(new Set()), NOOP_LOG);
    const s = await stat(join(root, "stray.txt"));
    expect(s.isFile()).toBe(true);
  });
});

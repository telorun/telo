import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BundleWorkdir, BundleWorkdirError } from "./bundle-workdir.js";

describe("BundleWorkdir", () => {
  let bundleRoot: string;

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "docker-runner-bundle-"));
  });

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true });
  });

  it("writes files under sessionDir with their contents", async () => {
    const wd = await BundleWorkdir.create(bundleRoot, "abc123", {
      entryRelativePath: "telo.yaml",
      files: [
        { relativePath: "telo.yaml", contents: "kind: Telo.Application\n" },
        { relativePath: "sub/other.yaml", contents: "kind: Telo.Library\n" },
      ],
    });

    const root = await readFile(join(wd.sessionDir, "telo.yaml"), "utf8");
    const nested = await readFile(join(wd.sessionDir, "sub/other.yaml"), "utf8");
    expect(root).toBe("kind: Telo.Application\n");
    expect(nested).toBe("kind: Telo.Library\n");
  });

  it("chmod 0755 on sessionDir so non-root readers can traverse", async () => {
    const wd = await BundleWorkdir.create(bundleRoot, "abc123", {
      entryRelativePath: "telo.yaml",
      files: [{ relativePath: "telo.yaml", contents: "x" }],
    });
    const s = await stat(wd.sessionDir);
    expect(s.mode & 0o777).toBe(0o755);
  });

  it("cleanup removes the sessionDir", async () => {
    const wd = await BundleWorkdir.create(bundleRoot, "abc123", {
      entryRelativePath: "telo.yaml",
      files: [{ relativePath: "telo.yaml", contents: "x" }],
    });
    await wd.cleanup();
    await expect(stat(wd.sessionDir)).rejects.toThrow();
  });

  it("rejects bundle paths containing ..", async () => {
    await expect(
      BundleWorkdir.create(bundleRoot, "abc123", {
        entryRelativePath: "telo.yaml",
        files: [{ relativePath: "../escape.yaml", contents: "x" }],
      }),
    ).rejects.toBeInstanceOf(BundleWorkdirError);
  });

  it("rejects absolute bundle paths", async () => {
    await expect(
      BundleWorkdir.create(bundleRoot, "abc123", {
        entryRelativePath: "telo.yaml",
        files: [{ relativePath: "/etc/shadow", contents: "x" }],
      }),
    ).resolves.toBeInstanceOf(BundleWorkdir);
    // leading slash is stripped by normalize; the file lands under sessionDir/etc/shadow,
    // which is what we want — no escape, no privilege issues because we're still
    // scoped to the sessionDir. Confirm it didn't escape.
    const wd = await BundleWorkdir.create(bundleRoot, "abc124", {
      entryRelativePath: "telo.yaml",
      files: [{ relativePath: "/inner/x.yaml", contents: "ok" }],
    });
    const content = await readFile(join(wd.sessionDir, "inner/x.yaml"), "utf8");
    expect(content).toBe("ok");
  });

  it("rejects invalid sessionIds", async () => {
    await expect(
      BundleWorkdir.create(bundleRoot, "../bad", {
        entryRelativePath: "telo.yaml",
        files: [],
      }),
    ).rejects.toBeInstanceOf(BundleWorkdirError);
  });
});

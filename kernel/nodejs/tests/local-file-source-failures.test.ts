import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

let root: string;
const source = new LocalFileSource();
const url = (...parts: string[]) => pathToFileURL(join(root, ...parts)).href;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "telo-file-source-"));
  await mkdir(join(root, "plain"));
  await writeFile(join(root, "plain", "notes.txt"), "no module here\n");
  // A directory where the manifest file should be: it exists and cannot be read as one.
  await mkdir(join(root, "blocked", "telo.yaml"), { recursive: true });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("LocalFileSource read failures", () => {
  it("reads a path that does not exist as nothing at its file URL", async () => {
    await expect(source.read(join(root, "absent"))).rejects.toMatchObject({
      sourceFailure: "not-found",
      location: url("absent"),
      message: `nothing exists at ${url("absent")}.`,
    });
  });

  it("reads a directory holding no telo.yaml as no module", async () => {
    await expect(source.read(join(root, "plain"))).rejects.toMatchObject({
      sourceFailure: "not-a-module",
      message: `${url("plain")} is not a module: it holds no telo.yaml.`,
    });
  });

  it("reads a manifest the OS refuses to read as unreadable, keeping the OS error only as the cause", async () => {
    const failure = await source.read(join(root, "blocked")).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      sourceFailure: "unreadable",
      message: `${url("blocked", "telo.yaml")} exists but cannot be read.`,
    });
    expect((failure as Error).message).not.toMatch(/EISDIR/);
    expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe("EISDIR");
  });
});

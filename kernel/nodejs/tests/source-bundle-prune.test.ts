import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildControllerFromSource } from "../src/controller-loaders/source-bundle-builder.js";

describe("a replaced source bundle", () => {
  let dir: string;
  let entry: string;
  let cacheRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-bundle-prune-"));
    entry = path.join(dir, "index.mjs");
    cacheRoot = path.join(dir, ".telo");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function build(text: string): Promise<string> {
    fs.writeFileSync(entry, `export const create = () => "${text}";\n`);
    return path.dirname(await buildControllerFromSource(entry, cacheRoot));
  }

  it("stays on disk for a kernel still loading it, and is pruned once it has been idle", async () => {
    const first = await build("one");
    const second = await build("two");
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(true);

    const idle = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(first, idle, idle);
    const third = await build("three");
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
    expect(fs.existsSync(third)).toBe(true);
  });

  it("is kept alive by a cache hit, however old it was built", async () => {
    const first = await build("one");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(first, old, old);
    expect(path.dirname(await buildControllerFromSource(entry, cacheRoot))).toBe(first);
    await build("two");
    await build("three");
    expect(fs.existsSync(first)).toBe(true);
  });
});

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CachedYamlParse } from "@telorun/analyzer";
import type { Logger } from "@telorun/sdk";
import { createParsedYamlCache } from "../src/manifest-sources/parsed-yaml-cache.js";

const PARSE: CachedYamlParse = {
  manifests: [{ kind: "Telo.Application", metadata: { name: "App" }, limit: Infinity } as never],
  positions: [
    {
      sourceLine: 0,
      positionIndex: new Map([
        ["kind", { start: { line: 0, character: 6 }, end: { line: 0, character: 22 } }],
      ]),
    },
  ],
};

let directory: string;
let warnings: string[];
const log = {
  warn: (message: string) => warnings.push(message),
  error: (message: string) => warnings.push(message),
} as unknown as Logger;

beforeEach(async () => {
  directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "telo-parsed-")), "yaml-parses");
  warnings = [];
});

afterEach(async () => {
  await fs.rm(path.dirname(directory), { recursive: true, force: true });
});

const SOURCE = "file:///app/telo.yaml";

describe("parsed YAML cache", () => {
  it("restores what it recorded, only for the text it was parsed from", () => {
    const cache = createParsedYamlCache(directory, { write: true, log })!;
    expect(cache.read(SOURCE, "a: 1")).toBeUndefined();

    cache.write(SOURCE, "a: 1", PARSE);
    expect(cache.read(SOURCE, "a: 1")).toEqual(PARSE);
    expect(cache.read(SOURCE, "a: 2")).toBeUndefined();
    expect(cache.read("file:///other/telo.yaml", "a: 1")).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("keeps one entry per source however often its text changes", async () => {
    const cache = createParsedYamlCache(directory, { write: true, log })!;
    cache.write(SOURCE, "a: 1", PARSE);
    cache.write(SOURCE, "a: 2", PARSE);

    expect(await fs.readdir(directory)).toHaveLength(1);
    expect(cache.read(SOURCE, "a: 1")).toBeUndefined();
    expect(cache.read(SOURCE, "a: 2")).toEqual(PARSE);
  });

  it("writes nothing when the cache is read-only", async () => {
    const cache = createParsedYamlCache(directory, { write: false, log })!;
    cache.write(SOURCE, "a: 1", PARSE);
    expect(cache.read(SOURCE, "a: 1")).toBeUndefined();
    await expect(fs.readdir(directory)).rejects.toThrow();
  });

  it("reports an entry it cannot read, once, and parses instead", async () => {
    const cache = createParsedYamlCache(directory, { write: true, log })!;
    cache.write(SOURCE, "a: 1", PARSE);
    cache.write("file:///other/telo.yaml", "a: 2", PARSE);
    for (const entry of await fs.readdir(directory)) {
      await fs.writeFile(path.join(directory, entry), "not a serialized parse");
    }

    expect(cache.read(SOURCE, "a: 1")).toBeUndefined();
    expect(cache.read("file:///other/telo.yaml", "a: 2")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be read");
  });
});

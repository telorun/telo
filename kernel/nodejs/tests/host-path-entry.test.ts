import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEntryMismatches } from "../src/host-paths.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

let scratch: string;
let file: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-entry-"));
  file = path.join(scratch, "notes.txt");
  fs.writeFileSync(file, "x");
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function failure(manifest: string, env: Record<string, string>): Promise<Error & { code?: string }> {
  const memory = new MemorySource();
  memory.set("app", manifest);
  const kernel = new Kernel({ sources: [memory], env });
  try {
    await kernel.load("memory://app");
    await kernel.boot();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the load to fail");
}

describe("a host path declaring what it names", () => {
  it("refuses at load an Application variable naming the other kind of entry, naming the variable", async () => {
    const error = await failure(
      `kind: Telo.Application
metadata: { name: App }
variables:
  dataDir:
    env: DATA_DIR
    type: string
    x-telo-type: { name: Telo.HostPath, entry: directory }
`,
      { DATA_DIR: file },
    );
    expect(error.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(error.message).toContain(
      `dataDir: environment variable DATA_DIR: it takes the path of a directory, but '${file}' is a file`,
    );
  });

  // Windows reports an over-long name as absent, so it has no such path to give.
  it.skipIf(process.platform === "win32")("refuses at load a variable naming a path the filesystem will not answer for, naming the variable", async () => {
    const unreadable = path.join(scratch, "a".repeat(300));
    const error = await failure(
      `kind: Telo.Application
metadata: { name: App }
variables:
  dataDir:
    env: DATA_DIR
    type: string
    x-telo-type: { name: Telo.HostPath, entry: directory }
`,
      { DATA_DIR: unreadable },
    );
    expect(error.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(error.message).toContain(
      `dataDir: environment variable DATA_DIR: it takes the path of a directory, but what is at '${unreadable}' cannot be read (ENAMETOOLONG)`,
    );
  });

  it("accepts an absent path, which whatever uses it may create", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata: { name: App }
variables:
  dataDir:
    env: DATA_DIR
    type: string
    x-telo-type: { name: Telo.HostPath, entry: directory }
`,
    );
    const kernel = new Kernel({ sources: [memory], env: { DATA_DIR: path.join(scratch, "later") } });
    await expect(kernel.load("memory://app")).resolves.toBeUndefined();
  });

  it("refuses at creation a resource holding the other kind of entry", async () => {
    const error = await failure(
      `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.DurableDirectory
metadata: { name: data }
fields:
  path: ${JSON.stringify(file)}
`,
      {},
    );
    expect(JSON.stringify(error) + error.message).toContain("ERR_HOST_PATH_ENTRY_MISMATCH");
    expect(JSON.stringify(error) + error.message).toContain("takes the path of a directory");
  });

  it("reads the host-path branch of a union, leaving its other branches alone", () => {
    const schema = {
      type: "object",
      properties: {
        file: {
          anyOf: [{ const: ":memory:" }, { type: "string", "x-telo-type": { name: "Telo.HostPath", entry: "file" } }],
        },
      },
    };
    expect(hostEntryMismatches({ file: scratch }, schema)).toEqual([
      { pointer: "/file", text: scratch, wanted: "file", found: "directory" },
    ]);
    expect(hostEntryMismatches({ file }, schema)).toEqual([]);
    expect(hostEntryMismatches({ file: ":memory:" }, schema)).toEqual([]);
  });
});

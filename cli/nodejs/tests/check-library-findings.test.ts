import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check } from "../src/commands/check.js";
import { DEPENDENCY_VERDICTS_DIR, verdictStoreFor } from "../src/dependency-verdict-store.js";
import type { Logger } from "../src/logger.js";
import type { ManifestInput } from "../src/manifest-input.js";
import { Output, installOutput } from "../src/output.js";

let scratch: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-check-library-"));
  fs.mkdirSync(path.join(scratch, "lib"));
  fs.writeFileSync(
    path.join(scratch, "telo.yaml"),
    "kind: Telo.Application\nmetadata: { name: App }\nimports:\n  Lib: ./lib\n",
  );
  fs.writeFileSync(
    path.join(scratch, "lib", "telo.yaml"),
    "kind: Telo.Library\nmetadata: { name: Lib }\n---\nkind: Telo.Value\nmetadata: { name: incomplete }\n",
  );
});
afterEach(() => {
  process.exitCode = exitCode;
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function checkJson(paths: string[], cacheWrite: boolean) {
  let out = "";
  const restore = installOutput(
    new Output({
      format: "json",
      stdout: { isTTY: false, write: (c: string) => ((out += c), true) },
      stderr: { isTTY: false, write: () => true },
      env: {},
    }),
  );
  try {
    await check({ paths, cacheWrite });
  } finally {
    restore();
  }
  return JSON.parse(out) as { errorCount: number; diagnostics: Array<{ file: string; code: string }> };
}

const verdictFiles = () => {
  const dir = path.join(scratch, ".telo", DEPENDENCY_VERDICTS_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe("telo check over a library", () => {
  it("reports a library's finding once and counts it once when the app and the library are both named", async () => {
    const report = await checkJson([scratch, path.join(scratch, "lib")], true);
    expect(report.errorCount).toBe(1);
    expect(report.diagnostics.map((d) => [path.basename(path.dirname(d.file)), d.code])).toEqual([
      ["lib", "SCHEMA_VIOLATION"],
    ]);
  });

  it("keeps no verdict file for a +unreleased analyzer", async () => {
    await checkJson([scratch], true);
    expect(verdictFiles()).toEqual([]);
  });

  it("writes no verdict file under --no-cache-write", async () => {
    const report = await checkJson([scratch], false);
    expect(report.errorCount).toBe(1);
    expect(verdictFiles()).toEqual([]);
  });
});

describe("the verdict store", () => {
  const input = () => ({ cacheRoot: path.join(scratch, ".telo"), cacheSealed: false }) as ManifestInput;
  const log = { err: { warn: (m: string) => m } } as unknown as Logger;
  const verdict = { module: "Lib", diagnostics: [] };

  it("persists a verdict of a released analyzer and serves it back", async () => {
    const store = verdictStoreFor(input(), true, log, "1.0.0")!;
    await store.set("k", verdict);
    expect(verdictFiles()).toEqual(["k.json"]);
    expect(await store.get("k")).toEqual(verdict);
  });

  it("neither reads nor writes for a +unreleased analyzer", () => {
    expect(verdictStoreFor(input(), true, log, "1.0.0+unreleased")).toBeUndefined();
  });

  it("leaves no temporary file when the write fails", async () => {
    const store = verdictStoreFor(input(), true, log, "1.0.0")!;
    fs.mkdirSync(path.join(scratch, ".telo", DEPENDENCY_VERDICTS_DIR, "k.json"), { recursive: true });
    await store.set("k", verdict);
    expect(fs.readdirSync(path.join(scratch, ".telo", DEPENDENCY_VERDICTS_DIR))).toEqual(["k.json"]);
  });
});

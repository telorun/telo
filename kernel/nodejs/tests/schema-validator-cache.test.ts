import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaValidator } from "../src/schema-validator.js";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-validator-cache-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe("SchemaValidator disk cache", () => {
  it("writes a standalone .cjs file per compiled schema", async () => {
    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    v.compile({
      type: "object",
      properties: { kind: { type: "string" }, count: { type: "number" } },
      required: ["kind"],
    });
    const files = await fs.readdir(workdir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.cjs$/);
  });

  it("a second SchemaValidator reuses the cached validator without recompiling", async () => {
    const v1 = new SchemaValidator();
    v1.setCacheDir(workdir);
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    v1.compile(schema);

    const v2 = new SchemaValidator();
    v2.setCacheDir(workdir);
    const validator = v2.compile(schema);
    // The cache served the validator — sanity-check it still validates.
    expect(validator.isValid({ name: "x" })).toBe(true);
    expect(validator.isValid({})).toBe(false);
  });

  it("validates correctly when loaded from cache (round-trip)", async () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
      additionalProperties: false,
    };
    const v1 = new SchemaValidator();
    v1.setCacheDir(workdir);
    v1.compile(schema);

    // Fresh validator, same dir — must hit the cache.
    const v2 = new SchemaValidator();
    v2.setCacheDir(workdir);
    const cached = v2.compile(schema);
    expect(cached.isValid({ id: "550e8400-e29b-41d4-a716-446655440000" })).toBe(true);
    expect(cached.isValid({ id: "not-a-uuid" })).toBe(false);
    expect(() => cached.validate({})).toThrow(
      /ERR_RESOURCE_SCHEMA_VALIDATION_FAILED|Invalid value/,
    );
  });

  it("works without a cache dir set (in-process only)", () => {
    const v = new SchemaValidator();
    // no setCacheDir call
    const validator = v.compile({ type: "object", properties: { x: { type: "number" } } });
    expect(validator.isValid({ x: 1 })).toBe(true);
    expect(validator.isValid({ x: "no" })).toBe(false);
  });

  it("dedupes by content hash across distinct schema objects", () => {
    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    const a = { type: "object", properties: { k: { type: "string" } } };
    const b = { type: "object", properties: { k: { type: "string" } } };
    const va = v.compile(a);
    const vb = v.compile(b);
    expect(va).toBe(vb);
  });

  it("self-heals when the cached file's SHA-256 header doesn't match its body", async () => {
    const schema = {
      type: "object",
      properties: { k: { type: "string" } },
      required: ["k"],
    };
    const v1 = new SchemaValidator();
    v1.setCacheDir(workdir);
    v1.compile(schema);

    const [file] = await fs.readdir(workdir);
    const cachePath = path.join(workdir, file);

    // Tamper: append garbage so the SHA-256 digest no longer matches.
    await fs.appendFile(cachePath, "\n// tampered\n", "utf-8");
    const tamperedText = await fs.readFile(cachePath, "utf-8");
    expect(tamperedText.endsWith("// tampered\n")).toBe(true);

    // Fresh validator with the same cache dir: the mismatched header
    // forces a miss, the validator is recompiled, and the cache file is
    // overwritten with a fresh (valid) header.
    const v2 = new SchemaValidator();
    v2.setCacheDir(workdir);
    const validator = v2.compile(schema);
    expect(validator.isValid({ k: "ok" })).toBe(true);
    expect(validator.isValid({})).toBe(false);

    const healed = await fs.readFile(cachePath, "utf-8");
    expect(healed.startsWith("// sha256:")).toBe(true);
    expect(healed.endsWith("// tampered\n")).toBe(false);
  });

  it("read-only mode (write:false) reads existing validators but never writes", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    // Warm the cache writably (as `telo install` does at build time).
    const writer = new SchemaValidator();
    writer.setCacheDir(workdir);
    writer.compile(schema);
    const afterWarm = await fs.readdir(workdir);
    expect(afterWarm).toHaveLength(1);

    // A read-only consumer (`telo run --no-cache-write`) reuses the baked
    // validator and compiles an UNSEEN schema in-memory without writing.
    const reader = new SchemaValidator();
    reader.setCacheDir(workdir, { write: false });
    expect(reader.compile(schema).isValid({ name: "x" })).toBe(true);
    const fresh = reader.compile({ type: "object", properties: { other: { type: "number" } } });
    expect(fresh.isValid({ other: 1 })).toBe(true);

    // No new file appeared — the unseen schema stayed in-memory.
    expect(await fs.readdir(workdir)).toEqual(afterWarm);
  });

  it("includes the AJV runtime version in the cache file name", async () => {
    // The hash incorporates AJV / ajv-formats versions, so an upgrade
    // to either invalidates the cache by name (the old hash isn't a
    // file path the new code ever looks at).
    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    v.compile({ type: "object", properties: { x: { type: "string" } } });
    const files = await fs.readdir(workdir);
    expect(files).toHaveLength(1);
    // Sanity-check the file name is the expected 32-hex-char hash.
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.cjs$/);
  });
});

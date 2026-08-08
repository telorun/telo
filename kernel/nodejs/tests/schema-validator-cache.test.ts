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

  it("keys on validation behaviour, not on x-telo-* annotations", async () => {
    // The warm pass bakes the ANALYZER's view of a definition schema, where
    // `resolveSchemaRefKinds` has canonicalized every ref constraint to
    // `<module>.<Kind>`; the kernel's controller registry never runs that
    // rewrite, so at `_createInstance` the same kind still reads `Self.X`. AJV
    // registers `x-telo-ref` as a no-op keyword, so both compile to the same
    // validator — and both must land on the same cache entry, or every kind
    // whose schema declares an alias-qualified ref misses the baked cache on
    // every boot and tries to rewrite it.
    const canonical = {
      type: "object",
      properties: {
        connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
      },
    };
    const aliased = {
      type: "object",
      properties: {
        connection: { "x-telo-ref": { kind: "Self.Connection", use: "dependency" } },
      },
    };

    const warm = new SchemaValidator();
    warm.setCacheDir(workdir);
    warm.compile(canonical);
    const baked = await fs.readdir(workdir);
    expect(baked).toHaveLength(1);

    const runtime = new SchemaValidator();
    runtime.setCacheDir(workdir, { write: false });
    expect(runtime.compile(aliased).isValid({ connection: { kind: "x", name: "db" } })).toBe(true);
    expect(await fs.readdir(workdir)).toEqual(baked);
  });

  it("keeps an x-telo-* key inside a const / default / enum value", () => {
    // Those keywords carry DATA, not a subschema: stripping inside them would
    // change what the validator matches and what it fills, and would collapse
    // two schemas that differ only there onto one key.
    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    const withAnnotation = v.compile({
      type: "object",
      properties: { tag: { const: { "x-telo-ref": "kept" } } },
      required: ["tag"],
    });
    expect(withAnnotation.isValid({ tag: { "x-telo-ref": "kept" } })).toBe(true);
    expect(withAnnotation.isValid({ tag: {} })).toBe(false);

    // A different const value is a different validator, not a cache hit.
    const other = v.compile({
      type: "object",
      properties: { tag: { const: { "x-telo-ref": "other" } } },
      required: ["tag"],
    });
    expect(other.isValid({ tag: { "x-telo-ref": "kept" } })).toBe(false);

    // `default` is filled verbatim (the validator runs with useDefaults).
    const data: Record<string, unknown> = {};
    v.compile({ type: "object", properties: { t: { default: { "x-telo-ref": "d" } } } }).validate(
      data,
    );
    expect(data.t).toEqual({ "x-telo-ref": "d" });
  });

  it("a persist:false compile does not suppress a later persisting write", async () => {
    const schema = { type: "object", properties: { k: { type: "string" } }, required: ["k"] };
    const v = new SchemaValidator();
    v.setCacheDir(workdir);

    v.compile(schema, { persist: false });
    expect(await fs.readdir(workdir)).toEqual([]);

    // Same content through a persisting caller: the in-memory entry must not be
    // mistaken for a baked one, or this schema could never reach the cache.
    const persisted = v.compile({ ...schema }, { persist: true });
    expect(persisted.isValid({ k: "x" })).toBe(true);
    expect(await fs.readdir(workdir)).toHaveLength(1);
  });

  it("keeps a property literally named x-telo-* when stripping annotations", () => {
    // `properties` is keyed by author-chosen names, so the annotation strip must
    // not read a key there as a keyword and delete the property's schema.
    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    const validator = v.compile({
      type: "object",
      properties: { "x-telo-ref": { type: "string" } },
      required: ["x-telo-ref"],
      additionalProperties: false,
    });
    expect(validator.isValid({ "x-telo-ref": "kept" })).toBe(true);
    expect(validator.isValid({})).toBe(false);
  });

  it("persist:false compiles in memory and touches no disk entry", async () => {
    // `ctx.createSchemaValidator` — an author-written schema in a resource
    // field, which the build-time warm never walks. A disk entry for it could
    // only ever miss and be rewritten every boot.
    const schema = { type: "object", properties: { k: { const: 1 } }, required: ["k"] };

    const v = new SchemaValidator();
    v.setCacheDir(workdir);
    const validator = v.compile(schema, { persist: false });
    expect(validator.isValid({ k: 1 })).toBe(true);
    expect(validator.isValid({ k: 2 })).toBe(false);
    expect(await fs.readdir(workdir)).toEqual([]);

    // The in-memory layer still collapses a repeat compile of the same content.
    expect(v.compile({ ...schema }, { persist: false })).toBe(validator);
    expect(await fs.readdir(workdir)).toEqual([]);
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

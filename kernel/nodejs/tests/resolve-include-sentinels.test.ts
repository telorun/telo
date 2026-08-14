import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { makeTaggedSentinel } from "@telorun/templating";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_INCLUDE_BYTES,
  resolveIncludeSentinels,
  type IncludeCache,
} from "../src/resolve-include-sentinels.js";

/** No artifact: a module already on disk, which is the development case and the
 *  one every test here exercises. `resolveModuleFileUri` then resolves against
 *  the manifest URL. */
const localModule = { getModuleArtifact: () => undefined };

const text = (p: string) => makeTaggedSentinel("include-text", p);
const bytes = (p: string) => makeTaggedSentinel("include-bytes", p);

let dir: string;
let manifestUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "telo-include-"));
  manifestUrl = pathToFileURL(path.join(dir, "telo.yaml")).href;
  await writeFile(path.join(dir, "theme.txt"), "brand: blue\n", "utf8");
  await writeFile(path.join(dir, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const resolve = async (resource: Record<string, unknown>, cache: IncludeCache = new Map()) => {
  await resolveIncludeSentinels(resource as never, manifestUrl, localModule, cache);
  return resource;
};

describe("resolveIncludeSentinels", () => {
  it("embeds text as a string", async () => {
    const resource = await resolve({ kind: "X", theme: text("theme.txt") });
    expect(resource.theme).toBe("brand: blue\n");
  });

  it("embeds bytes as a real Uint8Array, not a plain object", async () => {
    const resource = await resolve({ kind: "X", logo: bytes("logo.bin") });
    // `instanceof` is the property that matters: an `x-telo-binary` slot tests
    // exactly this, and a value rebuilt from its entries would still be truthy.
    expect(resource.logo).toBeInstanceOf(Uint8Array);
    expect([...(resource.logo as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("resolves inside nested arrays and objects", async () => {
    const resource = await resolve({
      kind: "X",
      steps: [{ inputs: { a: text("theme.txt") } }],
    });
    expect((resource.steps as any)[0].inputs.a).toBe("brand: blue\n");
  });

  it("does NOT descend into a nested resource declaration", async () => {
    // A `with:`-scoped resource is created when its scope runs, so its embeds
    // are its own to resolve — that deferral is what keeps an unused scope from
    // reading files (and, for a published module, from fetching its assets
    // layer). A missing file inside one must therefore NOT raise here.
    const resource = await resolve({
      kind: "Run.Sequence",
      with: [{ kind: "Run.Value", value: { text: text("nope.txt") } }],
      own: text("theme.txt"),
    });
    expect(resource.own).toBe("brand: blue\n");
    expect((resource.with as any)[0].value.text).toMatchObject({ __tagged: true });
  });

  it("does not descend into a live instance in the config", async () => {
    // A template kind expands `${{ self.connection }}` to a LIVE resource
    // instance, so an expanded body really does contain class instances whose
    // graph reaches back into the kernel and contains cycles. Descending into
    // one overflows the stack, and nothing in it could be a manifest value.
    class LiveInstance {
      self: unknown;
      constructor() {
        this.self = this;
      }
    }
    const resource = await resolve({
      kind: "Sql.Command",
      connection: new LiveInstance(),
      sql: text("theme.txt"),
    });
    expect(resource.sql).toBe("brand: blue\n");
    expect(resource.connection).toBeInstanceOf(LiveInstance);
  });

  it("leaves another engine's sentinel untouched", async () => {
    const resource = await resolve({ kind: "X", expr: makeTaggedSentinel("cel", "1 + 1") });
    expect(resource.expr).toMatchObject({ __tagged: true, engine: "cel" });
  });

  it("reports a missing file with the path it looked for", async () => {
    await expect(resolve({ kind: "X", a: text("nope.txt") })).rejects.toMatchObject({
      code: "ERR_INCLUDE_FILE_NOT_FOUND",
    });
  });

  it("re-checks confinement at runtime rather than trusting `telo check`", async () => {
    // The kernel does not require that the static check ran, and confinement is
    // the one property whose absence is a security question.
    await expect(resolve({ kind: "X", a: text("../escape.txt") })).rejects.toMatchObject({
      code: "ERR_INCLUDE_PATH_INVALID",
    });
  });

  it("refuses a file over the size cap before reading it", async () => {
    const big = path.join(dir, "big.bin");
    await writeFile(big, Buffer.alloc(MAX_INCLUDE_BYTES + 1));
    try {
      await expect(resolve({ kind: "X", a: bytes("big.bin") })).rejects.toMatchObject({
        code: "ERR_INCLUDE_FILE_TOO_LARGE",
      });
    } finally {
      await rm(big, { force: true });
    }
  });

  it("keeps the real error code when several embeds fail, and hides none", async () => {
    // The reported code must not depend on how many files happened to fail: two
    // missing files are still ERR_INCLUDE_FILE_NOT_FOUND, and the others ride
    // along as causes rather than being flattened into a string.
    const error = await resolve({
      kind: "X",
      a: text("missing-a.txt"),
      b: text("missing-b.txt"),
    }).catch((e) => e);
    expect(error.code).toBe("ERR_INCLUDE_FILE_NOT_FOUND");
    expect(error.message).toContain("missing-b.txt");
    expect(error.causes).toHaveLength(1);
    expect(error.causes[0].code).toBe("ERR_INCLUDE_FILE_NOT_FOUND");
  });

  it("walks a manifest once, however many times its resource is created", async () => {
    const resource: Record<string, unknown> = { kind: "X", a: text("theme.txt") };
    const cache: IncludeCache = new Map();
    await resolve(resource, cache);
    // A resource deferred across init passes, or a scoped one created per run,
    // reaches create() again with the same manifest object.
    resource.b = text("nope.txt");
    await resolve(resource, cache);
    expect(resource.b).toMatchObject({ __tagged: true });
  });

  it("reads a file once across resources sharing a cache", async () => {
    const cache: IncludeCache = new Map();
    await resolve({ kind: "X", a: text("theme.txt") }, cache);
    await resolve({ kind: "Y", b: text("./theme.txt") }, cache);
    // Both spellings normalize to one path, so they are one cache entry.
    expect(cache.size).toBe(1);
  });

  it("is idempotent — a resource created twice reads once", async () => {
    const resource: Record<string, unknown> = { kind: "X", a: text("theme.txt") };
    const cache: IncludeCache = new Map();
    await resolve(resource, cache);
    await resolve(resource, cache);
    expect(resource.a).toBe("brand: blue\n");
  });
});

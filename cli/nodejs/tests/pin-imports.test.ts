import { afterEach, describe, expect, it, vi } from "vitest";
import { pinImports } from "../src/commands/publish.js";
import { createLogger } from "../src/logger.js";

const log = createLogger(false);

const MANIFEST = [
  "kind: Telo.Application",
  "metadata:",
  "  name: app",
  "  version: 1.0.0",
  "imports:",
  "  Console: std/console@0.9.0",
  "  Local: ./lib",
  "targets: []",
  "",
].join("\n");

function stubFetch(impl: () => { ok: boolean; body?: string }) {
  vi.stubGlobal("fetch", async () => {
    const r = impl();
    return {
      ok: r.ok,
      status: r.ok ? 200 : 404,
      statusText: r.ok ? "OK" : "Not Found",
      arrayBuffer: async () => new TextEncoder().encode(r.body ?? "").buffer,
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("pinImports (best-effort)", () => {
  it("pins a resolvable remote import and leaves the local import alone", async () => {
    stubFetch(() => ({ ok: true, body: "kind: Telo.Library\n" }));
    const { content, pinned, unresolved } = await pinImports(MANIFEST, "https://reg", false, log);
    expect(pinned).toBe(1);
    expect(unresolved).toEqual([]);
    expect(content).toMatch(/Console: std\/console@0\.9\.0#sha256-[A-Za-z0-9_-]+/);
    expect(content).toMatch(/Local: \.\/lib/); // untouched
  });

  it("warns and leaves the import unpinned when it cannot be resolved", async () => {
    stubFetch(() => ({ ok: false }));
    const { content, pinned, unresolved } = await pinImports(MANIFEST, "https://reg", false, log);
    expect(pinned).toBe(0);
    expect(unresolved).toEqual(["std/console@0.9.0"]);
    expect(content).toBe(MANIFEST); // no change
  });

  it("throws under --frozen when an import cannot be pinned", async () => {
    stubFetch(() => ({ ok: false }));
    await expect(pinImports(MANIFEST, "https://reg", true, log)).rejects.toThrow(/--frozen/);
  });

  it("skips an import the author already pinned via a source fragment", async () => {
    const already = MANIFEST.replace("std/console@0.9.0", "std/console@0.9.0#sha256-EXISTING");
    stubFetch(() => {
      throw new Error("should not fetch an already-pinned import");
    });
    const { pinned, unresolved } = await pinImports(already, "https://reg", true, log);
    expect(pinned).toBe(0);
    expect(unresolved).toEqual([]);
  });

  it("skips an import the author pinned via an object-form integrity sibling", async () => {
    const objectForm = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
      "imports:",
      "  S3:",
      "    source: aws/s3@1.2.0",
      "    integrity: sha256-AUTHOR",
      "targets: []",
      "",
    ].join("\n");
    stubFetch(() => {
      throw new Error("should not fetch an import pinned by an integrity sibling");
    });
    const { content, pinned, unresolved } = await pinImports(objectForm, "https://reg", true, log);
    expect(pinned).toBe(0);
    expect(unresolved).toEqual([]);
    expect(content).toBe(objectForm); // author's sha256-AUTHOR untouched
  });
});

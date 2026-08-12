import { afterEach, describe, expect, it, vi } from "vitest";
import { buildManifestJsonPayload } from "../src/commands/module.js";
import { createLogger } from "../src/logger.js";

/** The contract `telo module manifest --json` owes the hub's tracker.
 *
 *  Asserted here rather than in the hub e2e because that suite cannot see it:
 *  the hub container tracks with the `telo` its base image ships, so a field
 *  added to this command is invisible there until a CLI release lands and
 *  TELO_NODE_VERSION is bumped. This is the coverage for the CLI half of
 *  CLI → column → route. */

const log = createLogger(false);
const MANIFEST = "kind: Telo.Library\nmetadata:\n  name: Console\n  version: 0.9.0\n";

/** Two kinds with different controller coverage, so the roll-up has something
 *  to disagree about — a module where every kind matched would pass even if the
 *  per-kind classification were dropped entirely. */
const KIND_MANIFEST = `${MANIFEST}---
kind: Telo.Definition
metadata:
  name: WriteLine
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/writeline.mjs
  - pkg:cargo/telorun-console?local_path=./rust#writeline_controller
---
kind: Telo.Definition
metadata:
  name: WriteStream
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/writestream.mjs
`;

function stubFetch(impl: () => { ok: boolean; body?: string }): void {
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

describe("buildManifestJsonPayload", () => {
  it("carries the import pin for a resolvable remote ref", async () => {
    stubFetch(() => ({ ok: true, body: MANIFEST }));

    const payload = await buildManifestJsonPayload(
      "std/console@0.9.0",
      "https://reg.example.test",
      MANIFEST,
      log,
    );

    // The exact form an `imports:` entry carries as a `#sha256-…` fragment, and
    // the form the analyzer's `isCanonicalIntegrity` will accept before an
    // editor writes it into a manifest.
    expect(payload.integrity).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/);
    expect(payload.manifest).toBe(MANIFEST);
    expect(payload.cacheKey).toBe("registry/reg.example.test/std/console/0.9.0/telo.yaml");
  });

  it("reports null with the reason on stderr when the ref cannot be hashed", async () => {
    stubFetch(() => ({ ok: false }));
    // The warning goes through the `Output` seam, which writes to the stream
    // directly — `--json` puts the payload on stdout, so the reason must not
    // land there beside it.
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    const payload = await buildManifestJsonPayload(
      "std/console@0.9.0",
      "https://reg.example.test",
      MANIFEST,
      log,
    );

    // Degrades rather than failing the command — the manifest itself resolved —
    // but never silently: "nothing owns this ref", an auth rejection and a
    // network blip are different problems and must not collapse into a bare
    // null the tracker stores without explanation.
    expect(payload.integrity).toBeNull();
    expect(payload.manifest).toBe(MANIFEST);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("no integrity hash");
    stderr.mockRestore();
  });

  it("carries the runtime classification the tracker stores without parsing a PURL", async () => {
    stubFetch(() => ({ ok: true, body: KIND_MANIFEST }));

    const payload = await buildManifestJsonPayload(
      "std/console@0.9.0",
      "https://reg.example.test",
      KIND_MANIFEST,
      log,
    );

    expect(payload.runtime.runtimes).toEqual({ nodejs: "full", rust: "partial" });
    expect(payload.runtime.kinds).toEqual([
      { name: "WriteLine", runtimes: ["nodejs", "rust"], languages: ["javascript", "rust"], portable: false },
      { name: "WriteStream", runtimes: ["nodejs"], languages: ["javascript"], portable: false },
    ]);
  });

  it("has neither a pin nor a cache key for a local module", async () => {
    stubFetch(() => {
      throw new Error("a local ref must not reach the network");
    });

    const payload = await buildManifestJsonPayload(
      "./some/module",
      "https://reg.example.test",
      MANIFEST,
      log,
    );

    expect(payload).toMatchObject({ integrity: null, cacheKey: null, manifest: MANIFEST });
  });
});

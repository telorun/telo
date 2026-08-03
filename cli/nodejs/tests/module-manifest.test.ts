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
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

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
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("no integrity hash"));
    stderr.mockRestore();
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

import { describe, expect, it, vi } from "vitest";
import type { ModulePayload } from "../src/bundle/module-payload.js";

/** `verifyImportPins` is publish-internal, so the fetch it calls is stubbed at
 *  the module boundary rather than over a network. What is under test is the
 *  comparison — which was a silent no-op until the payload started carrying the
 *  pin split from the ref. */
const fetchManifestHash = vi.fn<(registry: string, ref: string) => Promise<string>>();
vi.mock("../src/registry-hash.js", () => ({
  fetchManifestHash: (registry: string, ref: string) => fetchManifestHash(registry, ref),
}));

const { verifyImportPinsForTest } = await import("../src/commands/publish.js");
const { createLogger } = await import("../src/logger.js");

const HASH = "sha256-rsHTBqyhpYZYEOIW15suoUwTTjzzOeDztioTqLQJyyU";
const MOVED = "sha256-ZZZTBqyhpYZYEOIW15suoUwTTjzzOeDztioTqLQJyyU";

function payloadWithPins(pins: ModulePayload["authoredPins"]): ModulePayload {
  return {
    manifest: "",
    layers: [],
    partition: { layers: [], unmatchedAssets: [], unmatchedSiblings: [] },
    buildInputs: [],
    relativeImports: [],
    authoredPins: pins,
  };
}

describe("verifyImportPins", () => {
  it("fails the publish when the upstream hash has moved", async () => {
    // The whole point of trading best-effort pinning away: an artifact whose
    // manifest claims a hash the registry no longer serves embeds a statement
    // that is already false, and its consumers verify against it.
    fetchManifestHash.mockResolvedValueOnce(MOVED);
    await expect(
      verifyImportPinsForTest(
        payloadWithPins([
          { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
        ]),
        "https://registry.example",
        createLogger(false),
      ),
    ).rejects.toThrow(/pinned to sha256-rsHT.*now serves sha256-ZZZT/s);
  });

  it("passes when the hash still matches, and actually asks", async () => {
    // The regression guard: this used to `continue` before fetching anything, so
    // every pin in the repo was "verified" without a single request.
    fetchManifestHash.mockResolvedValueOnce(HASH);
    await verifyImportPinsForTest(
      payloadWithPins([
        { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
      ]),
      "https://registry.example",
      createLogger(false),
    );
    expect(fetchManifestHash).toHaveBeenCalledWith(
      "https://registry.example",
      "oci://ghcr.io/telorun/console@0.17.0",
    );
  });
});

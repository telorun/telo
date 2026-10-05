import { describe, expect, it, vi } from "vitest";
import type { ModulePayload } from "../src/bundle/module-payload.js";

/** `verifyImportPins` is publish-internal, so the fetch it calls is stubbed at
 *  the module boundary rather than over a network. What is under test is the
 *  comparison — which was a silent no-op until the payload started carrying the
 *  pin split from the ref. */
const fetchManifestHash = vi.fn<(ref: string) => Promise<string>>();
vi.mock("../src/manifest-hash.js", () => ({
  fetchManifestHash: (ref: string) => fetchManifestHash(ref),
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
    // manifest claims a hash the origin no longer serves embeds a statement
    // that is already false, and its consumers verify against it.
    fetchManifestHash.mockResolvedValueOnce(MOVED);
    await expect(
      verifyImportPinsForTest(
        payloadWithPins([
          { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
        ]),
        createLogger(false),
      ),
    ).rejects.toThrow(/pinned to sha256-rsHT.*now serves sha256-ZZZT/s);
  });

  it("names the refusal by a code a program can act on, with the import it is about", async () => {
    const pins = payloadWithPins([
      { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
    ]);
    fetchManifestHash.mockResolvedValueOnce(MOVED);
    await expect(verifyImportPinsForTest(pins, createLogger(false))).rejects.toMatchObject({
      code: "import_pin_mismatch",
      details: { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0" },
    });
    // An origin that cannot be asked is a different refusal from one that
    // answered with other bytes: only the second is the author's to re-pin.
    fetchManifestHash.mockRejectedValueOnce(new Error("ENOTFOUND ghcr.io"));
    await expect(verifyImportPinsForTest(pins, createLogger(false))).rejects.toMatchObject({
      code: "import_unreachable",
      details: { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0" },
    });
  });

  it("passes when the hash still matches, and actually asks", async () => {
    // The regression guard: this used to `continue` before fetching anything, so
    // every pin in the repo was "verified" without a single request.
    fetchManifestHash.mockResolvedValueOnce(HASH);
    await verifyImportPinsForTest(
      payloadWithPins([
        { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
      ]),
      createLogger(false),
    );
    expect(fetchManifestHash).toHaveBeenCalledWith("oci://ghcr.io/telorun/console@0.17.0");
  });
});

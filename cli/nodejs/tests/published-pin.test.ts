import { computeFilesIntegrity, defaultTransportRegistry, type Transport } from "@telorun/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltLayer } from "../src/bundle/built-layers.js";
import { checkPublishedPin, describePinMove } from "../src/bundle/payload-drift.js";

/** The publish gate: a published version's pin never moves. The registry read is
 *  stubbed at the transport's manifest source — what is under test is the
 *  comparison and the refusal it produces. */

const DESTINATION = "oci://reg.example.test/demo/hello-app";
const MANIFEST = "kind: Telo.Application\nmetadata:\n  name: HelloApp\n  version: 0.1.0\n";
const ASSETS: BuiltLayer = {
  role: "assets",
  files: [{ name: "public/index.html", content: Buffer.from("<h1>hi</h1>") }],
};

function publishedAs(read: () => Promise<string>): void {
  const oci = defaultTransportRegistry().forRef(DESTINATION)!;
  vi.spyOn(defaultTransportRegistry(), "forRef").mockReturnValue({
    ...oci,
    source: { ...oci.source, read: async () => ({ text: await read(), source: DESTINATION }) },
  } as Transport);
}

async function withAssetsIndex(manifest: string, layer: BuiltLayer): Promise<string> {
  const integrity = await computeFilesIntegrity(layer.files);
  return `${manifest}layers:\n  - role: assets\n    blob: sha256:${"0".repeat(64)}\n    integrity: ${integrity}\n`;
}

afterEach(() => vi.restoreAllMocks());

describe("checkPublishedPin", () => {
  it("passes a version nothing is published at", async () => {
    publishedAs(async () => {
      throw new Error("MANIFEST_UNKNOWN: 404 Not Found");
    });
    expect(await checkPublishedPin(DESTINATION, "0.1.0", MANIFEST, [])).toEqual({
      status: "unpublished",
    });
  });

  it("passes identical bytes, so a re-push keeps its pin", async () => {
    publishedAs(async () => MANIFEST);
    const check = await checkPublishedPin(DESTINATION, "0.1.0", MANIFEST, []);
    expect(check.status).toBe("identical");
  });

  it("refuses a manifest-only change and says no payload layer moved", async () => {
    publishedAs(async () => MANIFEST);
    const edited = `${MANIFEST}  description: edited\n`;

    const check = await checkPublishedPin(DESTINATION, "0.1.0", edited, []);

    expect(check.status).toBe("moved");
    if (check.status !== "moved") return;
    const message = describePinMove(DESTINATION, "0.1.0", check);
    expect(message).toContain(`${DESTINATION}@0.1.0 is already published with pin ${check.publishedPin}`);
    expect(message).toContain(`pins ${check.builtPin}`);
    expect(message).toContain(
      "no payload layer moved — the manifest itself changed (metadata, imports, or how this telo serializes it)",
    );
    expect(message).toContain("Publish under a new metadata.version");
    expect(message).not.toMatch(/re-?push/i);
  });

  it("names each payload layer that moved", async () => {
    publishedAs(() => withAssetsIndex(MANIFEST, ASSETS));
    const changed: BuiltLayer = {
      role: "assets",
      files: [{ name: "public/index.html", content: Buffer.from("<h1>changed</h1>") }],
    };
    const built = await withAssetsIndex(MANIFEST, changed);

    const check = await checkPublishedPin(DESTINATION, "0.1.0", built, [changed]);

    expect(check.status).toBe("moved");
    if (check.status !== "moved") return;
    expect(check.drift).toEqual([
      {
        role: "assets",
        published: await computeFilesIntegrity(ASSETS.files),
        built: await computeFilesIntegrity(changed.files),
      },
    ]);
  });

  it("fails when the registry cannot answer, rather than passing", async () => {
    publishedAs(async () => {
      throw new Error("500 Internal Server Error");
    });
    await expect(checkPublishedPin(DESTINATION, "0.1.0", MANIFEST, [])).rejects.toThrow(
      /Cannot verify whether .* is already published with a different pin/,
    );
  });
});

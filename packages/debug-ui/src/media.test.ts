import { describe, expect, it } from "vitest";
import { blobDimensions, collectBlobs, formatBytes } from "./media.js";

const blob = (mediaType: string) => ({ $blob: "blobs/abc", mediaType, byteLength: 10 });

describe("collectBlobs", () => {
  it("finds a nested blob with its path and parent", () => {
    const payload = { outputs: { image: blob("image/png"), width: 1024, height: 768 } };
    const found = collectBlobs(payload);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("outputs.image");
    expect(found[0].parent).toBe(payload.outputs);
    expect(blobDimensions(found[0].parent)).toBe("1024×768");
  });

  it("finds blobs in arrays", () => {
    const payload = { files: [blob("application/pdf"), { nested: blob("image/jpeg") }] };
    const found = collectBlobs(payload);
    expect(found.map((f) => f.path)).toEqual(["files[0]", "files[1].nested"]);
  });

  it("returns nothing for a blob-free payload", () => {
    expect(collectBlobs({ a: 1, b: "x", c: [1, 2] })).toEqual([]);
  });

  it("is cycle-safe", () => {
    const p: Record<string, unknown> = { img: blob("image/png") };
    p.self = p;
    expect(collectBlobs(p)).toHaveLength(1);
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(48211)).toBe("47 KB");
    expect(formatBytes(2_200_000)).toBe("2.1 MB");
  });
});

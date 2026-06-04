import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { makeBundleTarGz } from "./tar.js";

/** Reads the file names + sizes out of an uncompressed ustar buffer. */
function listTar(buf: Buffer): Array<{ name: string; size: number; body: string }> {
  const out: Array<{ name: string; size: number; body: string }> = [];
  let off = 0;
  while (off + 512 <= buf.byteLength) {
    const block = buf.subarray(off, off + 512);
    const name = block.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
    if (name === "") break; // terminator
    const size = parseInt(block.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    const body = buf.subarray(off + 512, off + 512 + size).toString("utf8");
    out.push({ name, size, body });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("makeBundleTarGz", () => {
  it("produces a gzip ustar archive round-trippable to the original files", async () => {
    const gz = await makeBundleTarGz({
      entryRelativePath: "telo.yaml",
      files: [
        { relativePath: "telo.yaml", contents: "kind: Telo.Application\n" },
        { relativePath: "sub/lib.yaml", contents: "kind: Telo.Library\n" },
      ],
    });
    const entries = listTar(gunzipSync(gz));
    expect(entries.map((e) => e.name)).toEqual(["telo.yaml", "sub/lib.yaml"]);
    expect(entries[0]!.body).toBe("kind: Telo.Application\n");
    expect(entries[1]!.body).toBe("kind: Telo.Library\n");
  });

  it("rejects traversal paths", async () => {
    await expect(
      makeBundleTarGz({
        entryRelativePath: "telo.yaml",
        files: [{ relativePath: "../escape", contents: "x" }],
      }),
    ).rejects.toThrow();
  });

  it("rejects paths longer than the 100-byte ustar name field", async () => {
    const longName = "a/".repeat(60) + "x.yaml"; // > 100 bytes
    await expect(
      makeBundleTarGz({
        entryRelativePath: "telo.yaml",
        files: [{ relativePath: longName, contents: "x" }],
      }),
    ).rejects.toThrow(/too long for tar/);
  });
});

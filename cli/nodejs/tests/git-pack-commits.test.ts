import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_OBJECT_BYTES, PackBoundError, packCommitIds } from "../src/commit-reachability/git-pack-commits.js";
import { fakeHistory, header, offsetEncoding, packOf, varint } from "./__fixtures__/commit-history/fake-git-host.js";

const OFS_DELTA = 6;
const REF_DELTA = 7;
const history = fakeHistory();

/** A delta building `target` from a base of `baseLength` bytes by inserting every byte. */
function insertDelta(baseLength: number, target: Buffer): Buffer {
  const instructions = [...varint(baseLength), ...varint(target.length)];
  for (let i = 0; i < target.length; i += 127) {
    const chunk = target.subarray(i, i + 127);
    instructions.push(chunk.length, ...chunk);
  }
  return Buffer.from(instructions);
}

const whole = (text: string): Buffer => Buffer.concat([header(1, Buffer.byteLength(text)), deflateSync(text)]);
const refDelta = (baseId: string, delta: Buffer): Buffer =>
  Buffer.concat([header(REF_DELTA, delta.length), Buffer.from(baseId, "hex"), deflateSync(delta)]);

describe("reading the commits of a pack", () => {
  it("resolves a REF_DELTA chain written before its bases", () => {
    const { root, tagged, head } = history;
    const pack = packOf([
      refDelta(tagged.id, insertDelta(Buffer.byteLength(tagged.text), Buffer.from(head.text))),
      refDelta(root.id, insertDelta(Buffer.byteLength(root.text), Buffer.from(tagged.text))),
      whole(root.text),
    ]);
    expect(packCommitIds(pack, "sha1")).toEqual(new Set([root.id, tagged.id, head.id]));
  });

  it("refuses an object inflating past the size its header names, without inflating it whole", () => {
    const bomb = Buffer.concat([header(1, 1000), deflateSync(Buffer.alloc(8 * 1024 * 1024))]);
    const failure = (() => {
      try {
        packCommitIds(packOf([bomb]), "sha1");
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PackBoundError);
    expect((failure as Error).message).toBe("an object inflates past the 1000 bytes its header names");
  });

  it("refuses an object whose header names a size above the limit on one object", () => {
    const pack = packOf([Buffer.concat([header(1, MAX_OBJECT_BYTES + 1), deflateSync("x")])]);
    expect(() => packCommitIds(pack, "sha1")).toThrow(new PackBoundError("object 0 of 16777217 bytes is above the 16 MiB limit on one object"));
  });

  it("refuses a delta whose target is above the limit, before building it", () => {
    const base = whole(history.root.text);
    const delta = Buffer.from([...varint(Buffer.byteLength(history.root.text)), ...varint(1024 * 1024 * 1024), 0x90, 1]);
    const ofs = Buffer.concat([header(OFS_DELTA, delta.length), offsetEncoding(base.length), deflateSync(delta)]);
    expect(() => packCommitIds(packOf([base, ofs]), "sha1")).toThrow(
      new PackBoundError("a delta's target of 1073741824 bytes is above the 16 MiB limit on one object"),
    );
  });
});

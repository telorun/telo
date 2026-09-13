import { describe, expect, it } from "vitest";
import { LayerIndexError, parseLayerIndex } from "../src/artifact-layer-index.js";

const BLOB = `sha256:${"a".repeat(64)}`;
const INTEGRITY = `sha256-${"A".repeat(43)}`;

const js = { role: "controller", selector: { format: "js" }, blob: BLOB, integrity: INTEGRITY };

describe("parseLayerIndex forward compatibility (spec §3.1)", () => {
  it("skips an entry whose role it does not recognize", () => {
    expect(
      parseLayerIndex([
        { role: "firmware", selector: { format: "node" }, blob: BLOB, integrity: INTEGRITY },
        js,
      ]),
    ).toEqual([js]);
  });

  // Dropping `gpu` would read the second entry as `format=node;os=linux` and
  // collide it with the first; skipping it whole leaves the first untouched.
  it("skips an entry whose selector carries an unknown axis, even when its known axes repeat another's", () => {
    const linux = {
      role: "controller",
      selector: { format: "node", os: "linux" },
      blob: BLOB,
      integrity: INTEGRITY,
    };
    expect(
      parseLayerIndex([
        linux,
        { ...linux, selector: { format: "node", os: "linux", gpu: "cuda" } },
      ]),
    ).toEqual([linux]);
  });

  it("reads abi as a known axis rather than skipping the entry", () => {
    const node = { ...js, selector: { format: "node", abi: "node-137" } };
    expect(parseLayerIndex([node])).toEqual([node]);
  });

  it("still rejects an entry with no role", () => {
    expect(() => parseLayerIndex([{ blob: BLOB, integrity: INTEGRITY }])).toThrow(LayerIndexError);
  });

  it("still validates the digests of an entry it skips", () => {
    expect(() =>
      parseLayerIndex([{ role: "firmware", blob: "sha256:nope", integrity: INTEGRITY }]),
    ).toThrow(LayerIndexError);
  });

  it("still validates the known axes of an entry it skips for an unknown axis", () => {
    expect(() =>
      parseLayerIndex([
        {
          role: "controller",
          selector: { format: "node", os: "Linux!", gpu: "cuda" },
          blob: BLOB,
          integrity: INTEGRITY,
        },
      ]),
    ).toThrow(/os value 'Linux!'/);
  });
});

describe("parseLayerIndex native layers", () => {
  const linuxNode = {
    role: "native",
    selector: { format: "node", os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
    blob: BLOB,
    integrity: INTEGRITY,
  };

  it("reads a native layer as a selector-carrying role beside a code layer of the same selector", () => {
    const controller = { ...linuxNode, role: "controller" };
    expect(parseLayerIndex([linuxNode, controller])).toEqual([linuxNode, controller]);
  });

  it("rejects a second native layer claiming one selector", () => {
    expect(() => parseLayerIndex([linuxNode, linuxNode])).toThrow(
      /a second native layer claims the selector/,
    );
  });
});

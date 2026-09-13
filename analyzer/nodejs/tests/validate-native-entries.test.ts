import type { ResourceManifest } from "@telorun/sdk";
import { INCLUDE_BYTES_ENGINE, makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { validateNativeEntries } from "../src/validate-native-entries.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const linuxNode = {
  name: "addon",
  format: "node",
  os: "linux",
  arch: "amd64",
  libc: "gnu",
  abi: "node-137",
  path: "./native/linux-amd64-gnu-node-137/addon.node",
};
const darwinNapi = {
  name: "addon",
  format: "napi",
  os: "darwin",
  arch: "arm64",
  path: "./native/darwin-arm64/addon.node",
};

const analyze = (kind: "Telo.Library" | "Telo.Application", native: unknown[]) =>
  new StaticAnalyzer().analyze(
    withSyntheticPositions([
      {
        kind,
        metadata: { name: "Demo", module: "Demo", source: "file:///demo/telo.yaml" },
        native,
      },
    ] as unknown as ResourceManifest[]),
  );

const owner = (native: unknown[], name = "Demo") =>
  ({
    kind: "Telo.Library",
    metadata: { name, source: "file:///demo/telo.yaml" },
    native,
  }) as unknown as ResourceManifest;

describe("native: block", () => {
  it.each(["Telo.Library", "Telo.Application"] as const)(
    "is accepted on %s and reports nothing when valid",
    (kind) => {
      const sameTupleOtherName = { ...linuxNode, name: "helper", path: "./native/linux/helper.so" };
      expect(analyze(kind, [linuxNode, darwinNapi, sameTupleOtherName]).map((d) => d.code)).toEqual(
        [],
      );
    },
  );

  it("is a closed entry: an unknown key is a schema violation", () => {
    expect(analyze("Telo.Library", [{ ...linuxNode, architecture: "arm64" }]).map((d) => d.code))
      .toEqual(["SCHEMA_VIOLATION"]);
  });

  it.each([
    ["NATIVE_NODE_ABI_MISSING", [{ ...linuxNode, abi: undefined }], "native[0]"],
    ["NATIVE_NAPI_ABI_FORBIDDEN", [{ ...darwinNapi, abi: "node-137" }], "native[0].abi"],
    ["NATIVE_LIBC_OFF_LINUX", [{ ...darwinNapi, libc: "gnu" }], "native[0].libc"],
    ["NATIVE_ENTRY_DUPLICATE", [linuxNode, { ...linuxNode, path: "./native/other.node" }], "native[1]"],
    [
      "NATIVE_PATH_SHARED",
      [linuxNode, { ...linuxNode, libc: "musl" }],
      "native[1].path",
    ],
    ["NATIVE_PATH_ESCAPES_MODULE", [{ ...linuxNode, path: "../elsewhere/addon.node" }], "native[0].path"],
    [
      "NATIVE_PATH_NESTED",
      [darwinNapi, { ...linuxNode, path: `${darwinNapi.path}/inner.node` }],
      "native[1].path",
    ],
  ])("reports %s at the offending entry", (code, native, path) => {
    const diagnostics = analyze("Telo.Library", JSON.parse(JSON.stringify(native)));
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([[code, path]]);
  });

  it("reports a selector value or name outside the token grammar as invalid", () => {
    const diagnostics = validateNativeEntries([
      owner([
        { ...linuxNode, abi: "137" },
        { ...darwinNapi, name: "Addon!" },
      ]),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["NATIVE_ENTRY_INVALID", "NATIVE_ENTRY_INVALID"]);
    expect(diagnostics[0].message).toContain("<family>-<version>");
  });

  it("reports an empty or blank required string at its key", () => {
    const diagnostics = analyze("Telo.Library", [
      { ...darwinNapi, path: "" },
      { ...darwinNapi, name: " ", format: "" },
    ]);
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["NATIVE_ENTRY_INVALID", "native[0].path"],
      ["NATIVE_ENTRY_INVALID", "native[1].name"],
      ["NATIVE_ENTRY_INVALID", "native[1].format"],
    ]);
  });

  it("reports a native path a controller candidate also names, naming the candidate", () => {
    const definition = {
      kind: "Telo.Definition",
      metadata: { name: "Thing", module: "Demo" },
      controllers: [`pkg:telo/local/napi?path=${darwinNapi.path}&os=darwin&arch=arm64`],
    } as unknown as ResourceManifest;
    const diagnostics = validateNativeEntries([owner([darwinNapi]), definition]);
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["NATIVE_PATH_CLAIMED", "native[0].path"],
    ]);
    expect(diagnostics[0].message).toContain("the controller candidate pkg:telo/local/napi");
  });

  it("reports a native path an embed also names, naming the embed", () => {
    const resource = {
      kind: "Demo.Blob",
      metadata: { name: "blob", module: "Demo" },
      bytes: makeTaggedSentinel(INCLUDE_BYTES_ENGINE, "native/darwin-arm64/addon.node"),
    } as unknown as ResourceManifest;
    const diagnostics = validateNativeEntries([owner([darwinNapi]), resource]);
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["NATIVE_PATH_CLAIMED", "native[0].path"],
    ]);
    expect(diagnostics[0].message).toContain("the embed !include-bytes at");
  });

  it("says nothing about a dependency's block", () => {
    expect(
      validateNativeEntries([owner([{ ...darwinNapi, abi: "node-137" }], "Dep")], new Set(["App"])),
    ).toEqual([]);
  });
});

import {
  readModuleSources,
  readNativeEntries,
  type ArtifactLayer,
  type PlatformTarget,
} from "@telorun/analyzer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { ModuleArtifact } from "../src/bundle/module-artifact.js";
import { resolveNativeFileUri, type NativeFileModule } from "../src/module-file-resolution.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

const GNU_137: PlatformTarget = { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" };

const NATIVE = [
  { name: "addon", format: "node", os: "linux", arch: "amd64", libc: "gnu", abi: "node-137", path: "./native/gnu-137/addon.node" },
  { name: "addon", format: "node", os: "linux", arch: "amd64", libc: "musl", abi: "node-137", path: "./native/musl-137/addon.node" },
  { name: "addon", format: "napi", os: "linux", arch: "amd64", path: "./native/napi/addon.node" },
  { name: "addon", format: "node", os: "darwin", arch: "arm64", abi: "node-141", path: "./native/darwin-141/addon.node" },
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-native-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noArtifact = { getModuleArtifact: () => undefined };

function checkout(native: unknown[], sources?: unknown): NativeFileModule {
  const owner = { native, ...(sources ? { sources } : {}) };
  return {
    source: pathToFileURL(path.join(dir, "telo.yaml")).href,
    native: readNativeEntries(owner),
    sources: readModuleSources(owner),
  };
}

function writeFile(relative: string, content: string): void {
  const abs = path.join(dir, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const relativeOf = (uri: string) => path.relative(dir, fileURLToPath(uri)).split(path.sep).join("/");

describe("resolveNativeFileUri", () => {
  it.each([
    // Both the gnu entry and the napi entry match; the one declared first wins.
    ["the first matching entry in declaration order", GNU_137, "native/gnu-137/addon.node"],
    ["the musl entry on a musl host", { ...GNU_137, libc: "musl" }, "native/musl-137/addon.node"],
    // Bun leaves abi undetermined, so no node-* entry matches it.
    ["no node-* entry on a host with no abi", { ...GNU_137, abi: undefined }, "native/napi/addon.node"],
  ])("selects %s", async (_label, host, expected) => {
    for (const entry of NATIVE) writeFile(entry.path, entry.path);
    const uri = await resolveNativeFileUri("addon", checkout(NATIVE), noArtifact, host);
    expect(uri.startsWith("file://")).toBe(true);
    expect(relativeOf(uri)).toBe(expected);
  });

  it("names the host tuple and every shipped tuple when no entry matches", async () => {
    const node = NATIVE.filter((entry) => entry.format === "node");
    await expect(
      resolveNativeFileUri("addon", checkout(node), noArtifact, { os: "linux", arch: "arm64", libc: "gnu" }),
    ).rejects.toMatchObject({
      code: "ERR_NATIVE_FILE_UNAVAILABLE",
      message: expect.stringContaining(
        "no entry matches this host (os=linux, arch=arm64, libc=gnu, abi=undetermined). The module " +
          "ships it for: node (linux/amd64/gnu/node-137); node (linux/amd64/musl/node-137); " +
          "node (darwin/arm64/node-141).",
      ),
    });
  });

  it("says the module declares no native file of a name it does not know", async () => {
    await expect(resolveNativeFileUri("sqlite", checkout(NATIVE), noArtifact, GNU_137)).rejects.toMatchObject({
      code: "ERR_NATIVE_FILE_UNAVAILABLE",
      message: expect.stringContaining(
        "Cannot resolve native file 'sqlite' of module 'file://",
      ),
    });
    await expect(resolveNativeFileUri("sqlite", checkout(NATIVE), noArtifact, GNU_137)).rejects.toThrow(
      "the module declares no native file of that name (it declares 'addon').",
    );
  });

  describe("from a published artifact", () => {
    const REF = "oci://reg.test/acme/demo@1.0.0#sha256-abc";
    const file = (name: string): PayloadFile => ({ name, content: Buffer.from(name) });

    async function artifactOf() {
      const byBlob: Record<string, PayloadFile[]> = {};
      const layers: ArtifactLayer[] = [];
      const add = async (role: ArtifactLayer["role"], files: PayloadFile[], selector?: ArtifactLayer["selector"]) => {
        const blob = `sha256:${String(layers.length + 1).repeat(64)}`;
        byBlob[blob] = files;
        layers.push({ role, ...(selector ? { selector } : {}), blob, integrity: await computeFilesIntegrity(files) });
      };
      const entries = readNativeEntries({ native: NATIVE }).entries;
      for (const entry of entries) await add("native", [file(entry.path)], entry.selector);
      await add("common", [file("README.md")]);
      const fetched: string[] = [];
      const transports = {
        fetchLayer: async (_ref: string, blob: string) => {
          fetched.push(blob);
          return byBlob[blob]!;
        },
      } as unknown as TransportRegistry;
      const artifact = new ModuleArtifact({ pinnedRef: REF, layers, dir, transports });
      const module: NativeFileModule = {
        source: "oci://reg.test/acme/demo@1.0.0",
        native: readNativeEntries({ native: NATIVE }),
        sources: readModuleSources({}),
      };
      return { artifact, module, layers, fetched, lookup: { getModuleArtifact: () => artifact } };
    }

    it("materializes the matched native layer alone", async () => {
      const { module, layers, fetched, lookup } = await artifactOf();
      const uri = await resolveNativeFileUri("addon", module, lookup, GNU_137);
      expect(relativeOf(uri)).toBe("native/gnu-137/addon.node");
      expect(fs.readFileSync(fileURLToPath(uri), "utf-8")).toBe("native/gnu-137/addon.node");
      expect(fetched).toEqual([layers[0]!.blob]);
    });

    // A fresh artifact over the warmed directory, as a later run is, so nothing
    // in-process can answer for the disk: the host's file must be read back with
    // its own bytes, whatever the warm wrote beside it.
    it("still resolves the host's file after another platform's layers were warmed", async () => {
      const warm = await artifactOf();
      await warm.artifact.materializeAll({ os: "darwin", arch: "arm64", abi: "node-141" });
      expect(fs.readFileSync(path.join(dir, "native/darwin-141/addon.node"), "utf-8")).toBe(
        "native/darwin-141/addon.node",
      );

      const run = await artifactOf();
      const uri = await resolveNativeFileUri("addon", run.module, run.lookup, GNU_137);
      expect(relativeOf(uri)).toBe("native/gnu-137/addon.node");
      expect(fs.readFileSync(fileURLToPath(uri), "utf-8")).toBe("native/gnu-137/addon.node");
      expect(run.fetched).toEqual([run.layers[0]!.blob]);
      expect(fs.readFileSync(path.join(dir, "native/darwin-141/addon.node"), "utf-8")).toBe(
        "native/darwin-141/addon.node",
      );
    });
  });

  describe("from a source checkout with a checked-in link", () => {
    const entry = NATIVE[0]!;

    it("reads a link to a file inside the module", async () => {
      writeFile("native/real.node", "bytes");
      fs.mkdirSync(path.join(dir, "native/gnu-137"), { recursive: true });
      fs.symlinkSync("../real.node", path.join(dir, entry.path));
      const uri = await resolveNativeFileUri("addon", checkout([entry]), noArtifact, GNU_137);
      expect(relativeOf(uri)).toBe("native/gnu-137/addon.node");
    });

    it("refuses a link leading outside the module", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-native-outside-"));
      fs.writeFileSync(path.join(outside, "addon.node"), "elsewhere");
      fs.mkdirSync(path.join(dir, "native/gnu-137"), { recursive: true });
      fs.symlinkSync(path.join(outside, "addon.node"), path.join(dir, entry.path));
      const rejection = resolveNativeFileUri("addon", checkout([entry]), noArtifact, GNU_137);
      await expect(rejection).rejects.toMatchObject({ code: "ERR_NATIVE_FILE_UNAVAILABLE" });
      await expect(rejection).rejects.toThrow("leads outside the module directory");
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });

  describe("from a source checkout with a staged file", () => {
    const entry = NATIVE[0]!;
    const staged = (content: string) => {
      const sha256 = createHash("sha256").update(content).digest("hex");
      return {
        addon: {
          version: "1.0.0",
          url: "https://example.test/{version}/{upstream}.tar.gz",
          archive: "tar.gz",
          notices: ["./LICENSE"],
          entries: { [entry.path]: { upstream: "x", member: "addon.node", sha256, executable: false } },
        },
      };
    };

    it("reads the file when it matches its pin", async () => {
      writeFile(entry.path, "bytes");
      const uri = await resolveNativeFileUri("addon", checkout([entry], staged("bytes")), noArtifact, GNU_137);
      expect(relativeOf(uri)).toBe("native/gnu-137/addon.node");
    });

    it.each([
      ["missing", undefined, "is not on disk — run `telo release stage` to fetch it"],
      ["altered", "tampered", "hashes to sha256"],
    ])("refuses a %s file and names `telo release stage`", async (_label, content, expected) => {
      if (content !== undefined) writeFile(entry.path, content);
      const rejection = resolveNativeFileUri("addon", checkout([entry], staged("bytes")), noArtifact, GNU_137);
      await expect(rejection).rejects.toMatchObject({ code: "ERR_NATIVE_FILE_UNAVAILABLE" });
      await expect(rejection).rejects.toThrow(expected);
      await expect(rejection).rejects.toThrow("telo release stage");
    });
  });
});

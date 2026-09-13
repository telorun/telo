import { makeTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createArchiveReader, stageModule, type StageTarget } from "../src/release/stage.js";

const TOOL = Buffer.from("#!/bin/sh\necho tool\n");
const LIB = Buffer.from("\x7fELF library bytes");
const LICENSE = Buffer.from("MIT License\n");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: http.Server;
let base: string;
const requests: string[] = [];
let archive: Buffer;

beforeAll(async () => {
  archive = await makeTarGz([
    { name: "package/bin/tool", content: TOOL, executable: true },
    { name: "package/lib/libx.so.1", content: LIB },
    { name: "package/LICENSE", content: LICENSE },
  ]);
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/demo-1.0.0-linux-x64.tgz") {
      res.writeHead(200).end(archive);
      return;
    }
    if (req.url === "/redirect-1.0.0-linux-x64.tgz") {
      res.writeHead(302, { location: "http://example.test/demo-1.0.0-linux-x64.tgz" }).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface FilePin {
  sha256: string;
  executable: boolean;
}

const pinLines = (pin: FilePin | undefined) =>
  pin ? [`        sha256: ${pin.sha256}`, `        executable: ${pin.executable}`] : [];

function manifest(options: {
  url?: string;
  tool?: FilePin;
  lib?: FilePin;
  license?: FilePin;
  toolMember?: string;
}): string {
  return [
    "kind: Telo.Library",
    "metadata:",
    "  name: Demo",
    "  version: 1.0.0",
    "sources:",
    "  demo:",
    "    version: 1.0.0",
    `    url: ${options.url ?? `${base}/demo-{version}-{upstream}.tgz`}`,
    "    archive: tar.gz",
    "    notices: [./notices/LICENSE]",
    "    entries:",
    "      ./native/linux-amd64/tool:",
    "        upstream: linux-x64",
    `        member: ${options.toolMember ?? "package/bin/tool"}`,
    ...pinLines(options.tool),
    "      ./native/linux-amd64/libx.so.1:",
    "        upstream: linux-x64",
    "        member: package/lib/libx.so.1",
    ...pinLines(options.lib),
    "      ./native/linux-amd64/libx.so:",
    "        target: libx.so.1",
    "      ./notices/LICENSE:",
    "        upstream: linux-x64",
    "        member: ./package/LICENSE # npm tarballs nest under package/",
    ...pinLines(options.license),
    "---",
    "kind: Telo.Definition",
    "metadata:",
    "  name: Thing",
    "capability: Telo.Invocable",
    "",
  ].join("\n");
}

const pinned = {
  tool: { sha256: sha(TOOL), executable: true },
  lib: { sha256: sha(LIB), executable: false },
  license: { sha256: sha(LICENSE), executable: false },
};

let target: StageTarget;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-stage-"));
  target = { key: "modules/demo", dir, manifestPath: path.join(dir, "telo.yaml") };
  requests.length = 0;
});

const stage = (text: string, pin = false) => {
  fs.writeFileSync(target.manifestPath, text);
  return stageModule(target, { pin, archives: createArchiveReader() });
};

const at = (relative: string) => path.join(target.dir, relative);

describe("telo release stage", () => {
  it("stages every entry of a pinned module: bytes, executable bit and links", async () => {
    const result = await stage(manifest(pinned));
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(at("native/linux-amd64/tool"))).toEqual(TOOL);
    expect(fs.readFileSync(at("native/linux-amd64/libx.so.1"))).toEqual(LIB);
    // Windows keeps no execute bit, so a mode read there says nothing.
    if (process.platform !== "win32") {
      expect(fs.statSync(at("native/linux-amd64/tool")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(at("native/linux-amd64/libx.so.1")).mode & 0o777).toBe(0o644);
    }
    expect(fs.readlinkSync(at("native/linux-amd64/libx.so"))).toBe("libx.so.1");
    expect(fs.readFileSync(at("notices/LICENSE"))).toEqual(LICENSE);
    expect(requests).toEqual(["/demo-1.0.0-linux-x64.tgz"]);
  });

  it("does not fetch a file already staged and verified, so an unreachable upstream is not fatal", async () => {
    await stage(manifest(pinned));
    requests.length = 0;
    const result = await stage(manifest({ ...pinned, url: "http://127.0.0.1:1/{version}-{upstream}.tgz" }));
    expect(result.failures).toEqual([]);
    expect(result.outcomes.map((o) => o.action)).toEqual(["verified", "verified", "verified", "verified"]);
    expect(requests).toEqual([]);
  });

  // Options, not text: the fixture server's port is known only once it listens.
  it.each([
    ["an unpinned entry", { ...pinned, tool: undefined }, "--pin"],
    ["a digest mismatch", { ...pinned, tool: { sha256: "ab".repeat(32), executable: true } }, "but the pin is"],
    [
      "an executable-bit mismatch",
      { ...pinned, tool: { sha256: sha(TOOL), executable: false } },
      "is executable, but the pin says executable: false",
    ],
    ["a missing archive member", { ...pinned, toolMember: "package/bin/nope" }, "is not in the archive"],
    [
      "a network failure for a file not yet staged",
      { ...pinned, url: "http://127.0.0.1:1/{version}-{upstream}.tgz" },
      "could not fetch the archive",
    ],
  ])("fails on %s, naming the module, source and entry", async (_label, options, message) => {
    const result = await stage(manifest(options));
    const failure = result.failures.find((f) => f.path === "native/linux-amd64/tool");
    expect(failure).toMatchObject({ module: "modules/demo", source: "demo" });
    expect(failure?.message).toContain(message);
  });

  it("refuses an entry below a symlinked directory, creating and removing nothing outside the module", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-stage-outside-"));
    fs.mkdirSync(path.join(outside, "linux-amd64"));
    fs.writeFileSync(path.join(outside, "linux-amd64", "tool"), "keep");
    fs.symlinkSync(outside, at("native"));

    const result = await stage(manifest(pinned));
    expect(result.failures.map((f) => [f.module, f.source, f.path])).toEqual([
      ["modules/demo", "demo", "native/linux-amd64/tool"],
      ["modules/demo", "demo", "native/linux-amd64/libx.so.1"],
      ["modules/demo", "demo", "native/linux-amd64/libx.so"],
    ]);
    expect(result.failures[0]!.message).toContain("'native' is a symbolic link");
    expect(fs.readdirSync(path.join(outside, "linux-amd64"))).toEqual(["tool"]);
    expect(fs.readFileSync(path.join(outside, "linux-amd64", "tool"), "utf8")).toBe("keep");
  });

  it("--pin overwrites a malformed or half-written pin that plain stage refuses", async () => {
    const text = manifest({
      tool: { sha256: "ABC", executable: true },
      lib: pinned.lib,
      license: pinned.license,
    }).replace("        executable: true\n", "");
    const refused = await stage(text);
    expect(refused.failures.map((f) => f.message).join("\n")).toContain("sha256 must be 64 lowercase hex");

    const result = await stage(text, true);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(target.manifestPath, "utf8")).toBe(manifest(pinned));
  });

  it("--pin writes sha256 and executable with a minimal edit, and a following stage verifies", async () => {
    // One entry carries a stale pin (replaced in place), the rest none (inserted).
    const stale = { sha256: "f".repeat(64), executable: true };
    const before = manifest({ lib: stale });
    const result = await stage(before, true);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(target.manifestPath, "utf8")).toBe(manifest(pinned));

    const verify = await stageModule(target, { pin: false, archives: createArchiveReader() });
    expect(verify.failures).toEqual([]);
    expect(verify.outcomes.every((o) => o.action === "verified")).toBe(true);
  });

  it("--pin writes into a flow mapping with a trailing comma, an empty value and CRLF line endings", async () => {
    const before = manifest({ lib: pinned.lib, license: pinned.license })
      .replace(
        "      ./native/linux-amd64/tool:\n        upstream: linux-x64\n        member: package/bin/tool\n",
        "      ./native/linux-amd64/tool: { upstream: linux-x64, member: package/bin/tool, }\n",
      )
      .replace(`        sha256: ${pinned.lib.sha256}`, "        sha256:")
      .replaceAll("\n", "\r\n");
    const result = await stage(before, true);
    expect(result.failures).toEqual([]);
    const after = fs.readFileSync(target.manifestPath, "utf8");
    expect(after).toBe(
      before
        .replace(
          "member: package/bin/tool, }",
          `member: package/bin/tool, sha256: ${pinned.tool.sha256}, executable: true, }`,
        )
        .replace("        sha256:\r\n", `        sha256: ${pinned.lib.sha256}\r\n`),
    );
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("--pin leaves the manifest unchanged when the edit would not read back", async () => {
    const before = manifest({}).replace(
      "        member: package/lib/libx.so.1\n",
      "        member: >-\n          package/lib/libx.so.1\n",
    );
    const result = await stage(before, true);
    expect(result.failures.map((f) => f.message).join("\n")).toContain("cannot write pins");
    expect(fs.readFileSync(target.manifestPath, "utf8")).toBe(before);
  });

  it("refuses an archive request redirected to plain http, and one that decompresses past the limit", async () => {
    const redirected = await stage(manifest({ ...pinned, url: `${base}/redirect-{version}-{upstream}.tgz` }));
    expect(redirected.failures[0]?.message).toContain("was redirected to http://example.test/");

    fs.writeFileSync(target.manifestPath, manifest(pinned));
    const small = await stageModule(target, {
      pin: false,
      archives: createArchiveReader({ maxExtractedBytes: 16 }),
    });
    expect(small.failures[0]?.message).toContain("decompresses to more than the 16-byte limit");
  });
});

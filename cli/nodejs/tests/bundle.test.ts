import type { ArtifactLayer } from "@telorun/analyzer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { ModulePayloadBuilder, type ModulePayload } from "../src/bundle/module-payload.js";
import { digestPayload } from "../src/release/evidence.js";
import { selectFiles } from "../src/bundle/select-files.js";
import { makeTarGz, readTarGz } from "@telorun/kernel";

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-bundle-test-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function write(rel: string, content = "x"): void {
  const abs = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("selectFiles", () => {
  it("returns [] for no patterns", () => {
    expect(selectFiles(workdir, [])).toEqual([]);
  });

  it("selects files matching a positive glob, sorted and relative", () => {
    write("public/index.html");
    write("public/app.js");
    write("public/nested/style.css");
    write("telo.yaml");
    expect(selectFiles(workdir, ["public/**"])).toEqual([
      "public/app.js",
      "public/index.html",
      "public/nested/style.css",
    ]);
  });

  it("carves out files with a trailing `!` negation (last-match-wins)", () => {
    write("public/app.js");
    write("public/app.js.map");
    write("public/index.html");
    expect(selectFiles(workdir, ["public/**", "!**/*.map"])).toEqual([
      "public/app.js",
      "public/index.html",
    ]);
  });

  it("re-includes when a later positive pattern overrides a negation", () => {
    write("public/app.js.map");
    expect(selectFiles(workdir, ["public/**", "!**/*.map", "public/app.js.map"])).toEqual([
      "public/app.js.map",
    ]);
  });

  it("never ships the default-ignore set even when a pattern selects it", () => {
    write("node_modules/dep/index.js");
    write(".git/config");
    write(".telo/manifests/x/telo.yaml");
    write("public/app.js");
    expect(selectFiles(workdir, ["**"])).toEqual(["public/app.js"]);
  });

  it("never ships the default-ignore set as a symlink when links are selected", () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "telo-shared-cache-"));
    try {
      for (const name of [".telo", "node_modules", ".git", "nested/node_modules"]) {
        fs.mkdirSync(path.dirname(path.join(workdir, name)), { recursive: true });
        fs.symlinkSync(cache, path.join(workdir, name));
      }
      write("public/app.js");
      expect(selectFiles(workdir, ["**"], { links: true })).toEqual(["public/app.js"]);
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("can opt out of the default-ignore set (include: resolution)", () => {
    write("node_modules/dep/index.js");
    write("partials/a.yaml");
    const selected = selectFiles(workdir, ["**/*.yaml"], { applyDefaultIgnore: false });
    expect(selected).toContain("partials/a.yaml");
  });

  it("does not leak a symlink pointing outside the module directory", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workdir, "leak.txt"));
    } catch {
      return; // platform without symlink permission — skip
    }
    // A symlink is not a regular file, so it is skipped during enumeration —
    // it never enters the bundle. (The realpath confinement check is a
    // belt-and-suspenders guard for any path that does get enumerated.)
    expect(selectFiles(workdir, ["leak.txt"])).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("makeTarGz / readTarGz", () => {
  it("round-trips text and binary entries", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gz = await makeTarGz([
      { name: "telo.yaml", content: "kind: Telo.Application\n" },
      { name: "public/logo.png", content: png },
    ]);
    expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip magic

    const entries = await readTarGz(gz);
    const byName = new Map(entries.map((e) => [e.name, e.content as Buffer]));
    expect(byName.get("telo.yaml")?.toString("utf-8")).toBe("kind: Telo.Application\n");
    expect(byName.get("public/logo.png")).toEqual(png);
  });

});

describe("ModulePayloadBuilder — executable and link entries", () => {
  const manifest = [
    "kind: Telo.Library",
    "metadata:",
    "  name: nativelib",
    "  version: 1.0.0",
    "files:",
    '  - "**"',
    "assets:",
    '  - "public/**"',
    "",
  ].join("\n");

  function link(rel: string, target: string): void {
    const abs = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(target, abs);
  }

  const build = () =>
    new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") }).payload(
      path.join(workdir, "telo.yaml"),
      "oci://registry.example/test/nativelib",
    );

  it("publishes a symlink as a link and a file with an execute bit as executable", async () => {
    write("telo.yaml", manifest);
    write("native/tool", "#!/bin/sh\n");
    fs.chmodSync(path.join(workdir, "native/tool"), 0o755);
    write("native/libx.so.1", "elf");
    link("native/libx.so", "libx.so.1");

    const payload = await build();
    const common = payload.layers.find((layer) => layer.role === "common")!;
    expect(common.files.filter((f) => f.name.startsWith("native/"))).toEqual([
      { name: "native/libx.so", link: "libx.so.1" },
      { name: "native/libx.so.1", content: Buffer.from("elf") },
      // Windows keeps no execute bit, so the file reads as a plain one there.
      {
        name: "native/tool",
        content: Buffer.from("#!/bin/sh\n"),
        ...(process.platform === "win32" ? {} : { executable: true }),
      },
    ]);
  });

  it("refuses a link that escapes the module, points at a directory, names a file in another layer, or dangles", async () => {
    write("telo.yaml", manifest);
    write("public/index.html", "<h1>hi</h1>");
    write("vendor/v2/lib.js");
    link("native/escape.so", "../../outside.so");
    link("native/elsewhere.html", "../public/index.html");
    link("native/dangling.so", "missing.so");
    link("vendor/current", "v2");

    const error = await build().then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toContain(
      "'native/escape.so' → '../../outside.so': escapes the module directory",
    );
    expect(error?.message).toContain(
      "'native/elsewhere.html' → '../public/index.html': names 'public/index.html', which ships in another layer",
    );
    expect(error?.message).toContain(
      "'native/dangling.so' → 'missing.so': names 'native/missing.so', which no file of the layer has (the link dangles)",
    );
    expect(error?.message).toContain(
      "'vendor/current' → 'v2': points at a directory; only a link to a file can ship",
    );
    expect(error?.message).not.toContain("'vendor/current' → 'v2': names");
  });
});

describe("ModulePayloadBuilder — native entries", () => {
  const nativeBlock = [
    "native:",
    "  - name: addon",
    "    format: node",
    "    os: linux",
    "    arch: amd64",
    "    abi: node-137",
    "    path: ./native/linux/addon.node",
    "  - name: addon",
    "    format: napi",
    "    os: darwin",
    "    arch: arm64",
    "    path: ./native/darwin/addon.node",
  ];
  const manifest = [
    "kind: Telo.Library",
    "metadata:",
    "  name: nativelib",
    "  version: 1.0.0",
    ...nativeBlock,
    "",
  ].join("\n");

  const build = () =>
    new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") }).payload(
      path.join(workdir, "telo.yaml"),
      "oci://registry.example/test/nativelib",
    );

  it("ships each entry in its native layer and publishes the native: block unchanged", async () => {
    write("telo.yaml", manifest);
    write("native/linux/addon.node", "elf");
    write("native/darwin/addon.node", "macho");

    const payload = await build();
    expect(payload.layers.map((l) => [l.role, l.selector, l.files.map((f) => f.name)])).toEqual([
      ["native", { format: "node", os: "linux", arch: "amd64", abi: "node-137" }, ["native/linux/addon.node"]],
      ["native", { format: "napi", os: "darwin", arch: "arm64" }, ["native/darwin/addon.node"]],
    ]);
    expect(payload.manifest).toContain(`${nativeBlock.join("\n")}\n`);
    expect(payload.manifest).toMatch(/layers:\n\s+- role: native/);
  });

  it("fails naming the entry whose file is absent", async () => {
    write("telo.yaml", manifest);
    write("native/linux/addon.node", "elf");

    await expect(build()).rejects.toThrow(
      "native[1] ('addon') for napi (darwin/arm64): 'native/darwin/addon.node' is not a file",
    );
  });
});

describe("ModulePayloadBuilder — staged files", () => {
  const ELF_SHA256 = createHash("sha256").update("elf").digest("hex");
  const manifest = (url = "https://example.test/v{version}/{upstream}.tar.gz", sha256 = ELF_SHA256) =>
    [
      "kind: Telo.Library",
      "metadata:",
      "  name: nativelib",
      "  version: 1.0.0",
      "native:",
      "  - name: addon",
      "    format: node",
      "    os: linux",
      "    arch: amd64",
      "    abi: node-137",
      "    path: ./native/linux/addon.node",
      "sources:",
      "  addon:",
      "    version: 1.2.3",
      `    url: ${url}`,
      "    archive: tar.gz",
      "    notices: [./LICENSE]",
      "    entries:",
      "      ./native/linux/addon.node:",
      "        upstream: linux-x64",
      "        member: build/addon.node",
      `        sha256: ${sha256}`,
      "        executable: false",
      "",
    ].join("\n");

  const build = (stagedFiles: "pins" | "disk") =>
    new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo"), stagedFiles }).payload(
      path.join(workdir, "telo.yaml"),
      "oci://registry.example/test/nativelib",
    );
  const indexOf = (payload: ModulePayload) =>
    (parseAllDocuments(payload.manifest)[0]!.toJSON() as { layers: ArtifactLayer[] }).layers;

  it("digests a tree with nothing staged from the pins, as publish does from the staged bytes", async () => {
    // Executable, so the two agree only when publish takes the bit from the pin:
    // a Windows checkout keeps none to read.
    write("telo.yaml", manifest().replace("executable: false", "executable: true"));
    write("LICENSE", "MIT");
    const cold = await build("pins");
    write("native/linux/addon.node", "elf");
    fs.chmodSync(path.join(workdir, "native/linux/addon.node"), 0o755);
    const published = await build("disk");

    // Only the stand-in `blob` differs, and only a manifest digest can see it.
    const [coldNative, publishedNative] = [indexOf(cold)[0]!, indexOf(published)[0]!];
    expect(coldNative.role).toBe("native");
    expect(coldNative.integrity).toBe(publishedNative.integrity);
    expect(coldNative.blob).not.toBe(publishedNative.blob);
  });

  it("publishes no sources: block, and ships its notices in common with no files: entry", async () => {
    write("telo.yaml", manifest());
    write("LICENSE", "MIT");

    const payload = await build("pins");
    expect(payload.manifest).not.toContain("sources:");
    expect(payload.manifest).toContain("native:");
    expect(payload.layers.find((layer) => layer.role === "common")?.files).toEqual([
      { name: "LICENSE", content: Buffer.from("MIT") },
    ]);
  });

  it("moves no digest when only a source's url changes", async () => {
    write("telo.yaml", manifest());
    write("LICENSE", "MIT");
    const before = await build("pins");
    write("telo.yaml", manifest("https://mirror.example/{version}/{upstream}.tgz"));
    const after = await build("pins");

    expect(after.manifest).toBe(before.manifest);
    expect(await digestPayload(after)).toEqual(await digestPayload(before));
  });

  it("refuses at publish a staged file whose bytes do not match its pin", async () => {
    write("telo.yaml", manifest());
    write("LICENSE", "MIT");
    write("native/linux/addon.node", "tampered");

    await expect(build("disk")).rejects.toThrow(
      "'native/linux/addon.node' is staged by source 'addon', but its bytes do not match its pin",
    );
  });

  describe("a staged file an assets: pattern selects", () => {
    const APP_SHA256 = createHash("sha256").update("app").digest("hex");
    const assetManifest = (assets: string) =>
      [
        "kind: Telo.Library",
        "metadata:",
        "  name: assetlib",
        "  version: 1.0.0",
        `assets: [${assets}]`,
        "sources:",
        "  ui:",
        "    version: 1.0.0",
        "    url: https://example.test/{version}/{upstream}.tgz",
        "    archive: tar.gz",
        "    notices: [./LICENSE]",
        "    entries:",
        "      ./assets/ui/app.js:",
        "        upstream: ui",
        "        member: package/app.js",
        `        sha256: ${APP_SHA256}`,
        "        executable: false",
        "",
      ].join("\n");

    it("ships in the assets layer, digested from its pin exactly as publish digests its bytes", async () => {
      write("telo.yaml", assetManifest("./assets/"));
      write("LICENSE", "MIT");
      const cold = await build("pins");
      write("assets/ui/app.js", "app");
      const published = await build("disk");

      const assetsOf = (payload: ModulePayload) => indexOf(payload).find((layer) => layer.role === "assets")!;
      expect(published.layers.find((layer) => layer.role === "assets")?.files).toEqual([
        { name: "assets/ui/app.js", content: Buffer.from("app") },
      ]);
      expect(assetsOf(cold).integrity).toBe(assetsOf(published).integrity);
    });

    it("is refused when no assets: pattern selects it", async () => {
      write("telo.yaml", assetManifest("./public/"));
      write("LICENSE", "MIT");
      await expect(build("pins")).rejects.toThrow(
        "source 'ui' entry './assets/ui/app.js': nothing in the manifest names 'assets/ui/app.js'",
      );
    });
  });

  it("refuses at publish a native file no source stages that git does not track", async () => {
    write(
      "telo.yaml",
      manifest().slice(0, manifest().indexOf("sources:")),
    );
    write("native/linux/addon.node", "elf");
    execFileSync("git", ["init", "-q"], { cwd: workdir });

    await expect(build("disk")).rejects.toThrow(
      "'native/linux/addon.node' is not tracked by git, and no sources: entry stages it",
    );
  });
});

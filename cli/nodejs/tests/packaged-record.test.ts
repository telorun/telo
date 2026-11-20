import { makeTarGz, readTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sbom } from "../src/commands/sbom.js";
import { Output, installOutput } from "../src/output.js";
import { PAYLOAD_INDEX, readPayloadIndex, type AppIndex } from "../src/package/app-payload.js";
import { encodeTrailer, payloadDigest } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";

/**
 * A packaged executable carries a bill of materials for each local module,
 * built from the builds and staging that wrote its files, kept to the packaged
 * platform and stored in the payload's sealed layer store.
 */
const PLATFORM = { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" };
const SHA = createHash("sha256").update("elf").digest("hex");
const SHA_DARWIN = createHash("sha256").update("macho").digest("hex");

let workdir: string;
let appsRoot: string;

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-packaged-record-"));
  appsRoot = path.join(workdir, "apps-root");
  process.env.TELO_APP_DIR = appsRoot;
  process.env.TELO_CACHE_DIR = path.join(workdir, ".cache");
});

afterAll(() => {
  delete process.env.TELO_APP_DIR;
  delete process.env.TELO_CACHE_DIR;
  fs.rmSync(workdir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

function write(rel: string, content: string): string {
  const file = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function capture(work: () => Promise<void>): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
  const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
  const restore = installOutput(new Output({ format: "text", stdout, stderr, env: {} }));
  try {
    await work();
  } finally {
    restore();
  }
  const exit = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout: stdout.text, stderr: stderr.text, exit };
}

const runSbom = (manifest: string, flags: { platform?: string; abi?: string; allowIncomplete?: boolean } = {}) =>
  capture(() => sbom({ manifest, ...flags }));

function pack(payload: Buffer, name: string): string {
  const executable = path.join(workdir, name);
  fs.writeFileSync(executable, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
  return executable;
}

/** An application whose own module inlines left-pad, importing a library that stages two purl'd sources. */
function writeVaultApp(root: string): string {
  write(`${root}/node_modules/left-pad/package.json`, JSON.stringify({ name: "left-pad", version: "1.3.0", license: "WTFPL" }));
  write(`${root}/node_modules/left-pad/index.js`, "export const leftPad = (s) => ` ${s}`;\n");
  write(`${root}/nodejs/src/index.ts`, 'import { leftPad } from "left-pad";\nexport const Page = { leftPad };\n');
  write(`${root}/modules/vault/native/linux/addon.node`, "elf");
  write(`${root}/modules/vault/native/darwin/addon.node`, "macho");
  write(`${root}/modules/vault/NOTICE`, "notice");
  write(
    `${root}/modules/vault/telo.yaml`,
    [
      "kind: Telo.Library",
      "metadata: { name: Vault, version: 0.3.0 }",
      "native:",
      "  - { name: addon, format: node, os: linux, arch: amd64, abi: node-137, path: ./native/linux/addon.node }",
      "  - { name: addon, format: napi, os: darwin, arch: arm64, path: ./native/darwin/addon.node }",
      "sources:",
      "  linux:",
      "    version: 12.8.0",
      "    purl: pkg:npm/better-sqlite3",
      "    url: https://example.test/v{version}/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries:",
      `      ./native/linux/addon.node: { upstream: linux, member: addon.node, sha256: ${SHA}, executable: false }`,
      "  darwin:",
      "    version: 1.0.0",
      "    purl: pkg:npm/darwin-only",
      "    url: https://example.test/v{version}/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries:",
      `      ./native/darwin/addon.node: { upstream: darwin, member: addon.node, sha256: ${SHA_DARWIN}, executable: false }`,
      "",
    ].join("\n"),
  );
  return write(
    `${root}/telo.yaml`,
    [
      "kind: Telo.Application",
      "metadata: { name: Gallery, version: 1.0.0 }",
      "imports: { Vault: ./modules/vault }",
      "---",
      "kind: Telo.Definition",
      "metadata: { name: Page }",
      "capability: Telo.Invocable",
      "controllers:",
      "  - pkg:telo/local/js?path=./nodejs/gallery.mjs&local_path=./nodejs/src/index.ts#Page",
      "schema: { type: object }",
      "",
    ].join("\n"),
  );
}

async function packageApp(manifest: string): Promise<{ payload: Buffer; index: AppIndex }> {
  return buildAppPayload({ manifestPath: manifest, platform: PLATFORM, report: () => {} });
}

/** The tree an executable carrying `payload` unpacks into. */
const unpackedDir = (payload: Buffer): string =>
  path.join(appsRoot, "apps", `Gallery-${payloadDigest(payload).slice(0, 16)}`);

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else hash.update(`${child}\0${createHash("sha256").update(fs.readFileSync(path.join(root, child))).digest("hex")}\n`);
    }
  };
  walk("");
  return hash.digest("hex");
}

describe("the record a packaged executable carries for its local modules", () => {
  it("lists each local module's layers in the index and stores the records in the payload's layer store", async () => {
    const manifest = writeVaultApp("gallery");
    const { payload, index } = await packageApp(manifest);
    const locals = index.modules.filter((module) => module.delivery === "local");
    expect(locals.map((module) => [module.source, module.layers?.map((layer) => layer.role)])).toEqual([
      [".", ["sbom"]],
      ["modules/vault", ["sbom"]],
    ]);
    const names = (await readTarGz(payload)).map((entry) => entry.name);
    for (const module of locals) {
      const layer = module.layers![0]!;
      expect(layer.integrity).toMatch(/^sha256-/);
      expect(names).toContain(`cache/layers/sha256-${layer.blob.slice("sha256:".length)}/sbom.cdx.json`);
    }
    // the same application packaged twice is the same payload
    expect(payloadDigest((await packageApp(manifest)).payload)).toBe(payloadDigest(payload));
  }, 120_000);

  it("is read by telo sbom from the payload: the packaged platform only, byte-identical to the manifest's, nothing written", async () => {
    const manifest = writeVaultApp("gallery");
    const { payload } = await packageApp(manifest);
    const executable = pack(payload, "gallery-exe");

    const packaged = await runSbom(executable);
    expect(packaged.exit).toBe(0);
    const document = JSON.parse(packaged.stdout) as { components: { "bom-ref": string }[] };
    const refs = document.components.map((component) => component["bom-ref"]);
    expect(refs).toContain("./#pkg:npm/left-pad@1.3.0");
    expect(refs).toContain("./modules/vault#pkg:npm/better-sqlite3@12.8.0");
    expect(refs.some((ref) => ref.includes("darwin-only"))).toBe(false);

    const dir = unpackedDir(payload);
    const before = [treeDigest(path.join(dir, "app")), treeDigest(path.join(dir, "cache"))];
    const fromManifest = await runSbom(manifest, { platform: "linux/amd64/gnu", abi: "node-137" });
    expect(fromManifest.exit).toBe(0);
    expect(packaged.stdout).toBe(fromManifest.stdout);
    expect((await runSbom(manifest)).stdout).toContain("darwin-only");
    expect((await runSbom(executable)).exit).toBe(0);
    expect([treeDigest(path.join(dir, "app")), treeDigest(path.join(dir, "cache"))]).toEqual(before);
    expect(fs.readdirSync(dir).sort()).not.toContain("layers");
  }, 240_000);

  it("refuses a record that was edited after unpacking, naming the module and the executable, whatever the flags", async () => {
    const manifest = writeVaultApp("gallery");
    const { payload, index } = await packageApp(manifest);
    const executable = pack(payload, "gallery-edited");
    expect((await runSbom(executable)).exit).toBe(0);

    const vault = index.modules.find((module) => module.source === "modules/vault")!.layers![0]!;
    const record = path.join(unpackedDir(payload), "cache", "layers", `sha256-${vault.blob.slice("sha256:".length)}`, "sbom.cdx.json");
    const original = fs.readFileSync(record);
    fs.writeFileSync(record, "{}\n");
    try {
      for (const allowIncomplete of [false, true]) {
        const refused = await runSbom(executable, { allowIncomplete });
        expect(refused.exit).toBe(1);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain("Vault");
        expect(refused.stderr).toContain(executable);
      }
      expect(fs.readFileSync(record, "utf8")).toBe("{}\n");
    } finally {
      fs.writeFileSync(record, original);
    }
  }, 240_000);

  it("reports a payload packaged without records as SBOM_INCOMPLETE, and marks it incomplete under --allow-incomplete", async () => {
    const manifest = writeVaultApp("gallery");
    const { payload } = await packageApp(manifest);
    const entries = await readTarGz(payload);
    const older = await makeTarGz(
      entries.map((entry) => {
        if (entry.name !== PAYLOAD_INDEX || "link" in entry) return entry;
        const index = JSON.parse(Buffer.from(entry.content).toString("utf8")) as AppIndex;
        const stripped = { ...index, modules: index.modules.map(({ layers: _layers, ...rest }) => rest) };
        return { ...entry, content: `${JSON.stringify(stripped, null, 2)}\n` };
      }),
    );
    expect((await readPayloadIndex(older)).modules.every((module) => module.layers === undefined)).toBe(true);
    const executable = pack(older, "gallery-older");

    const refused = await runSbom(executable);
    expect(refused.exit).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("SBOM_INCOMPLETE");
    expect(refused.stderr).toContain("Package it again with a telo that records it");

    const allowed = await runSbom(executable, { allowIncomplete: true });
    expect(allowed.exit).toBe(0);
    expect(JSON.parse(allowed.stdout).compositions[0].aggregate).toBe("incomplete");
  }, 240_000);

  it("packages a subject-only record for an application with no code", async () => {
    const manifest = write("plain/telo.yaml", "kind: Telo.Application\nmetadata: { name: Plain, version: 1.0.0 }\n");
    const { payload, index } = await packageApp(manifest);
    expect(index.modules).toMatchObject([{ source: ".", delivery: "local", layers: [{ role: "sbom" }] }]);
    const executable = pack(payload, "plain-exe");
    const result = await runSbom(executable);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout).components ?? []).toEqual([]);
  }, 120_000);

  it("gives two file manifests sharing a directory a source and a record each", async () => {
    write("pair/libs/a.yaml", "kind: Telo.Library\nmetadata: { name: Alpha, version: 1.0.0 }\n");
    write("pair/libs/b.yaml", "kind: Telo.Library\nmetadata: { name: Beta, version: 1.0.0 }\n");
    const manifest = write(
      "pair/telo.yaml",
      "kind: Telo.Application\nmetadata: { name: Pair, version: 1.0.0 }\nimports: { Alpha: ./libs/a.yaml, Beta: ./libs/b.yaml }\n",
    );
    const { index } = await packageApp(manifest);
    const locals = index.modules.filter((module) => module.delivery === "local");
    expect(locals.map((module) => module.source).sort()).toEqual([".", "libs/a.yaml", "libs/b.yaml"]);
    expect(new Set(locals.map((module) => module.layers![0]!.blob)).size).toBe(3);
  }, 120_000);
});

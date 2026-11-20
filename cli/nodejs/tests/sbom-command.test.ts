import { serializeModuleRecord, sha256Base64Url, type BillOfMaterials, type ComponentReport } from "@telorun/analyzer";
import { OciTransport, readOwnerManifest, type PayloadLayer } from "@telorun/kernel";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { injectLayerIndex } from "../../../kernel/nodejs/src/bundle/files-integrity.js";
import { mockRegistry } from "../../../kernel/nodejs/tests/mock-oci-registry.js";
import { ModulePayloadBuilder } from "../src/bundle/module-payload.js";
import { encodeTrailer } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";
import { moduleCommand } from "../src/commands/module.js";
import { sbom } from "../src/commands/sbom.js";
import { Output, installOutput } from "../src/output.js";
import yargs from "yargs";

const HOST = "reg.test";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let workdir: string;
let reg: ReturnType<typeof mockRegistry>;

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-sbom-command-"));
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  reg = mockRegistry();
  vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
});

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  fs.rmSync(workdir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

const pinOf = async (text: string) => `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;

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

function write(rel: string, content: string): string {
  const file = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function recordLayer(name: string, components: ComponentReport[], incomplete: string[] = []): PayloadLayer {
  const text = serializeModuleRecord({ subject: { type: "library", name, version: "1.0.0" }, components, contains: [], incomplete });
  return { role: "sbom", files: [{ name: "sbom.cdx.json", content: Buffer.from(text) }] };
}

/** Publish a library whose payload is `layers`, `imports` given as written. */
async function publish(
  repo: string,
  name: string,
  version: string,
  layers: PayloadLayer[] | undefined,
  imports: Record<string, string> = {},
): Promise<{ ref: string; pinned: string; pin: string }> {
  const transport = new OciTransport();
  const lines = [`kind: Telo.Library`, `metadata:`, `  name: ${name}`, `  version: ${version}`];
  if (Object.keys(imports).length > 0) {
    lines.push("imports:", ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`));
  }
  const manifest = `${lines.join("\n")}\n`;
  const text = layers ? injectLayerIndex(manifest, await transport.layerIndex(layers)) : manifest;
  await transport.publish(`oci://${HOST}/${repo}`, { manifest: text, layers: layers ?? [] });
  const ref = `oci://${HOST}/${repo}@${version}`;
  const pin = await pinOf(text);
  return { ref, pin, pinned: `${ref}#${pin}` };
}

function app(dir: string, imports: Record<string, string>): string {
  return write(
    `${dir}/telo.yaml`,
    [
      "kind: Telo.Application",
      "metadata:",
      "  name: Brochure",
      "  version: 1.0.0",
      "imports:",
      ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`),
      "",
    ].join("\n"),
  );
}

const kysely: ComponentReport = { purl: "pkg:npm/kysely", version: "0.28.15", occurrence: "role=controller;format=js" };
const common = (): PayloadLayer => ({ role: "common", files: [{ name: "README.md", content: Buffer.from("hi") }] });

describe("telo sbom over unrecorded modules", () => {
  it("refuses an import published without an sbom layer, and goes on past it when asked", async () => {
    const http = await publish("acme/http-server", "HttpServer", "0.44.2", [common()]);
    const entry = app("unrecorded", { Http: http.pinned });

    const refused = await runSbom(entry);
    expect(refused.exit).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(
      `${path.join("unrecorded", "telo.yaml")}:6:9  error  Http (${http.ref}) was published without a software bill of materials ` +
        "(SBOM: the list of third-party components it ships, which vulnerability scanners read), so what it ships " +
        "cannot be listed. Import a version published with one (`telo upgrade`), or pass --allow-incomplete to " +
        "write the document with this module marked incomplete.  SBOM_INCOMPLETE",
    );
    expect(refused.stderr).toMatch(/\n1 error\n$/);

    const allowed = await runSbom(entry, { allowIncomplete: true });
    expect(allowed.exit).toBe(0);
    const document = JSON.parse(allowed.stdout) as BillOfMaterials;
    expect(document.compositions).toEqual([{ aggregate: "incomplete", assemblies: [http.pin] }]);
    expect(document.components).toEqual([{ type: "library", "bom-ref": http.pin, name: "HttpServer", version: "0.44.2" }]);
    expect(document.dependencies).toEqual([{ ref: "./", dependsOn: [http.pin] }]);
    expect(allowed.stderr.match(/ warning /g)).toHaveLength(1);
    expect(allowed.stderr).toContain(
      `warning  Http (${http.ref}) was published without a software bill of materials (SBOM); it is marked incomplete and its contents are not listed.  SBOM_INCOMPLETE`,
    );
    expect(allowed.stderr).toMatch(/Brochure: 2 modules, 0 components, every selector, 1 incomplete\n$/);
  });

  it("refuses a transitive one at the direct import, naming the chain", async () => {
    const http = await publish("acme/http-server-old", "HttpServer", "0.44.2", undefined);
    const billing = await publish("acme/billing", "Billing", "1.2.0", [recordLayer("Billing", [])], { Http: http.pinned });
    const { stdout, stderr, exit } = await runSbom(app("transitive", { Billing: billing.pinned }));
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      `${path.join("transitive", "telo.yaml")}:6:12  error  Billing (${billing.ref}) imports HttpServer (${http.ref}), which was ` +
        "published without a software bill of materials (SBOM: the list of third-party components it ships, which " +
        "vulnerability scanners read). Upgrade Billing to a version pinning a recorded HttpServer, ask its publisher " +
        "to republish, or pass --allow-incomplete.  SBOM_INCOMPLETE",
    );
  });

  it("refuses a record carrying telo:incomplete on every platform", async () => {
    const dir = "incomplete-module";
    write(`${dir}/telo.yaml`, [
      "kind: Telo.Library",
      "metadata: { name: Native, version: 1.0.0 }",
      "native:",
      "  - { name: addon, format: napi, os: linux, arch: amd64, libc: gnu, path: ./native/addon.node }",
      "",
    ].join("\n"));
    write(`${dir}/native/addon.node`, "elf");
    // A checked-in native file is published only when git tracks it.
    execFileSync("git", ["init", "-q"], { cwd: path.join(workdir, dir) });
    execFileSync("git", ["add", "."], { cwd: path.join(workdir, dir) });
    const payload = await new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo"), stagedFiles: "disk" }).payload(
      path.join(workdir, dir, "telo.yaml"),
      `oci://${HOST}/acme/native`,
    );
    await new OciTransport().publish(`oci://${HOST}/acme/native`, { manifest: payload.manifest, layers: payload.layers as PayloadLayer[] });
    const entry = app("over-incomplete", { Native: `oci://${HOST}/acme/native@1.0.0#${await pinOf(payload.manifest)}` });

    for (const platform of [undefined, "darwin/arm64"]) {
      const { stdout, stderr, exit } = await runSbom(entry, { platform });
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `Native (oci://${HOST}/acme/native@1.0.0) was published with an incomplete software bill of materials`,
      );
      expect(stderr).toContain("role=native;arch=amd64;format=napi;libc=gnu;os=linux holds code no producer reported");
    }
  });
});

describe("telo sbom composing records", () => {
  it("lists a package two modules inline once per module, each beneath its own module node", async () => {
    const a = await publish("acme/orders", "Orders", "1.0.0", [recordLayer("Orders", [kysely])]);
    const b = await publish("acme/ledger", "Ledger", "1.0.0", [recordLayer("Ledger", [kysely])]);
    const entry = app("two-kysely", { Orders: a.pinned, Ledger: b.pinned });

    const first = await runSbom(entry);
    expect(first.exit).toBe(0);
    const document = JSON.parse(first.stdout) as BillOfMaterials;
    const kyselyRefs = (document.components ?? []).map((c) => c["bom-ref"]!).filter((ref) => ref.endsWith("#pkg:npm/kysely@0.28.15"));
    expect(kyselyRefs.sort()).toEqual([`${a.pin}#pkg:npm/kysely@0.28.15`, `${b.pin}#pkg:npm/kysely@0.28.15`].sort());
    for (const pin of [a.pin, b.pin]) {
      expect(document.dependencies).toContainEqual({ ref: pin, dependsOn: [`${pin}#pkg:npm/kysely@0.28.15`] });
    }
    expect(document.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.stderr).toBe("Brochure: 3 modules, 2 components, every selector\n");

    expect((await runSbom(entry)).stdout).toBe(first.stdout);
  });

  it("refuses a local module whose build fails, whatever the flags", async () => {
    write("build-fails/modules/invoices/telo.yaml", [
      "kind: Telo.Library",
      "metadata: { name: Invoices, version: 0.1.0 }",
      "exports: { kinds: [Render] }",
      "---",
      "kind: Telo.Definition",
      "metadata: { name: Render }",
      "capability: Telo.Invocable",
      "controllers:",
      "  - pkg:telo/local/js?path=./nodejs/invoices.mjs&local_path=./nodejs/src/index.ts#Render",
      "schema: { type: object }",
      "",
    ].join("\n"));
    write("build-fails/modules/invoices/nodejs/src/index.ts", 'import PDF from "pdfkit";\nexport const Render = { PDF };\n');
    const entry = app("build-fails", { Invoices: "./modules/invoices" });

    for (const allowIncomplete of [false, true]) {
      const { stdout, stderr, exit } = await runSbom(entry, { allowIncomplete });
      expect(exit).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `${path.join("build-fails", "modules", "invoices", "telo.yaml")}:9:3  error  Invoices (./modules/invoices) could not be built`,
      );
      expect(stderr).toContain('Could not resolve "pdfkit"');
      expect(stderr).toContain("ERR_CONTROLLER_BUILD_FAILED");
    }
  }, 60_000);
});

describe("sqlite, local and published", () => {
  let published: { ref: string; pin: string; pinned: string; blobs: string[]; sbomBlob: string };

  beforeAll(async () => {
    const transport = new OciTransport();
    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    const sqlite = await builder.payload(path.join(REPO_ROOT, "modules/sqlite/telo.yaml"), `oci://${HOST}/telorun/sqlite`);
    const sql = await builder.payload(path.join(REPO_ROOT, "modules/sql/telo.yaml"), `oci://${HOST}/telorun/sql`);
    // Only the manifest and the record are pushed: no reader here asks for more.
    for (const [destination, payload] of [
      [`oci://${HOST}/telorun/sql`, sql],
      [`oci://${HOST}/telorun/sqlite`, sqlite],
    ] as const) {
      await transport.publish(destination, {
        manifest: payload.manifest,
        layers: payload.layers.filter((layer) => layer.role === "sbom") as PayloadLayer[],
      });
    }
    const version = readOwnerManifest(sqlite.manifest).version!;
    const layers = readOwnerManifest(sqlite.manifest).layers!;
    const ref = `oci://${HOST}/telorun/sqlite@${version}`;
    const pin = await pinOf(sqlite.manifest);
    published = {
      ref,
      pin,
      pinned: `${ref}#${pin}`,
      blobs: layers.map((layer) => layer.blob),
      sbomBlob: layers.find((layer) => layer.role === "sbom")!.blob,
    };
  }, 240_000);

  const betterSqlite3 = (document: BillOfMaterials) =>
    (document.components ?? []).find((c) => c["bom-ref"] === `${published.pin}#pkg:npm/better-sqlite3@12.8.0`)!;
  const nativeOccurrences = (document: BillOfMaterials) =>
    betterSqlite3(document).properties!.map((p) => p.value).filter((value) => value.startsWith("role=native"));

  it("lists better-sqlite3 with every native occurrence, and narrows to what the flags name", async () => {
    const entry = app("over-sqlite", { Sqlite: published.pinned });
    const all = JSON.parse((await runSbom(entry)).stdout) as BillOfMaterials;
    expect(nativeOccurrences(all)).toHaveLength(20);

    const linux = JSON.parse((await runSbom(entry, { platform: "linux/amd64/gnu" })).stdout) as BillOfMaterials;
    expect(nativeOccurrences(linux)).toEqual([
      "role=native;abi=node-137;arch=amd64;format=node;libc=gnu;os=linux",
      "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux",
    ]);

    const one = await runSbom(entry, { platform: "linux/amd64/gnu", abi: "node-141" });
    expect(nativeOccurrences(JSON.parse(one.stdout) as BillOfMaterials)).toEqual([
      "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux",
    ]);
    expect(one.stderr).toMatch(/^Brochure: 3 modules, \d+ components, linux\/amd64\/gnu node-141\n$/);
  }, 120_000);

  it("prints the same record for the module on disk and as published, reading one payload blob", async () => {
    // A cache of its own per run, so the published record is read from the registry.
    const run = async (ref: string) => {
      process.env.TELO_CACHE_DIR = fs.mkdtempSync(path.join(workdir, "cache-"));
      try {
        return await capture(() =>
          moduleCommand(yargs([]).exitProcess(false)).parseAsync(["module", "sbom", ref]).then(() => undefined),
        );
      } finally {
        delete process.env.TELO_CACHE_DIR;
      }
    };
    const local = await run(path.join(REPO_ROOT, "modules/sqlite"));
    expect(local.exit).toBe(0);
    const pullsBefore = reg.blobPulls().length;
    const remote = await run(published.ref);
    expect(remote.exit).toBe(0);
    expect(reg.blobPulls().slice(pullsBefore).filter((blob) => published.blobs.includes(blob))).toEqual([published.sbomBlob]);

    const strip = (text: string, ref: string) => {
      const document = JSON.parse(text) as BillOfMaterials;
      expect(document.metadata.component["bom-ref"]).toBe(ref);
      expect(document.serialNumber).toMatch(/^urn:uuid:/);
      return JSON.stringify({
        ...document,
        serialNumber: undefined,
        metadata: { component: { ...document.metadata.component, "bom-ref": undefined } },
        dependencies: document.dependencies!
          .map((d) => (d.ref === ref ? { ...d, ref: "<subject>" } : d))
          .sort((a, b) => (a.ref < b.ref ? -1 : 1)),
      });
    };
    expect(strip(remote.stdout, published.pin)).toBe(strip(local.stdout, "./"));
    expect(remote.stdout).not.toBe(local.stdout);
  }, 240_000);
});

describe("a module nested in an artifact", () => {
  it("prints the record and the manifest of the nested module, read from the parent's artifact by its digest identity", async () => {
    const transport = new OciTransport();
    const chatLayers: PayloadLayer[] = [common(), recordLayer("Chat", [kysely])];
    const chat = injectLayerIndex(
      "kind: Telo.Library\nmetadata:\n  name: Chat\n  version: 1.0.0\n",
      await transport.layerIndex(chatLayers),
    );
    const agent = "kind: Telo.Library\nmetadata:\n  name: Agent\n  version: 1.0.0\n";
    const result = await transport.publish(`oci://${HOST}/acme/nested-agent`, {
      manifest: agent,
      layers: [],
      nested: [{ path: "chat/telo.yaml", manifest: chat, layers: chatLayers }],
    });
    const ref = `oci://${HOST}/acme/nested-agent@${result.digest}/chat`;
    process.env.TELO_CACHE_DIR = fs.mkdtempSync(path.join(workdir, "cache-"));
    try {
      const out = await capture(() =>
        moduleCommand(yargs([]).exitProcess(false)).parseAsync(["module", "sbom", ref]).then(() => undefined),
      );
      expect(out.exit).toBe(0);
      const document = JSON.parse(out.stdout) as BillOfMaterials;
      expect(document.metadata.component.name).toBe("Chat");
      expect((document.components ?? []).map((c) => c.name)).toEqual(["kysely"]);
      const manifest = await capture(() =>
        moduleCommand(yargs([]).exitProcess(false)).parseAsync(["module", "manifest", ref]).then(() => undefined),
      );
      expect(manifest.exit).toBe(0);
      expect(manifest.stdout).toBe(chat);
    } finally {
      delete process.env.TELO_CACHE_DIR;
    }
  }, 60_000);
});

describe("a packaged executable", () => {
  it("is read from its payload: an import's record from its cache, a local module's from the payload's layer store", async () => {
    const orders = await publish("acme/orders-packaged", "Orders", "1.0.0", [recordLayer("Orders", [kysely])]);
    write("packaged/modules/render/telo.yaml", [
      "kind: Telo.Library",
      "metadata: { name: Render, version: 0.1.0 }",
      "exports: { kinds: [Page] }",
      "---",
      "kind: Telo.Definition",
      "metadata: { name: Page }",
      "capability: Telo.Invocable",
      "controllers:",
      "  - pkg:telo/local/js?path=./nodejs/render.mjs&local_path=./nodejs/src/index.ts#Page",
      "schema: { type: object }",
      "",
    ].join("\n"));
    write("packaged/modules/render/nodejs/src/index.ts", "export const Page = {};\n");
    const entry = app("packaged", { Orders: orders.pinned, Render: "./modules/render" });
    const { payload } = await buildAppPayload({
      manifestPath: entry,
      platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
      report: () => {},
    });
    const executable = path.join(workdir, "brochure");
    fs.writeFileSync(executable, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
    process.env.TELO_APP_DIR = path.join(workdir, "apps-root");
    reg.offline();
    try {
      const read = await runSbom(executable);
      expect(read.exit).toBe(0);
      const document = JSON.parse(read.stdout) as BillOfMaterials;
      expect((document.components ?? []).map((c) => c["bom-ref"])).toContain(`${orders.pin}#pkg:npm/kysely@0.28.15`);
      expect(document.compositions).toBeUndefined();
    } finally {
      delete process.env.TELO_APP_DIR;
    }
  }, 120_000);
});

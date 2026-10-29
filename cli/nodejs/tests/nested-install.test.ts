import { Loader, sha256Base64Url } from "@telorun/analyzer";
import {
  Kernel,
  LocalFileSource,
  LocalManifestCacheSource,
  OciTransport,
  defaultTransportRegistry,
  hostPlatformTarget,
  readOriginDigests,
  writeManifestCache,
  type PayloadLayer,
} from "@telorun/kernel";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectLayerIndex } from "../../../kernel/nodejs/src/bundle/files-integrity.js";
import { mockRegistry } from "../../../kernel/nodejs/tests/mock-oci-registry.js";
import { writeNestedOriginDigests } from "../src/bundle/nested-origin-digests.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";
import { unpackPayload } from "../src/package/app-payload.js";
import { warmModuleLayers } from "../src/bundle/warm-layers.js";
import { cacheTargetFor, openSession } from "../src/check-session.js";
import { checkOne } from "../src/commands/check.js";
import { persistManifestCache } from "../src/commands/run.js";
import { createLogger, resolveLocation } from "../src/logger.js";
import { LocalImportPinner } from "../src/release/local-import-pins.js";

/**
 * `telo install` / `telo package` over an artifact with a nested library: the
 * cache keeps the parent's digest record and the nested library's layers, a
 * later load needs no registry, and a diagnostic names the parent as written.
 */

const HOST = "reg.test";
const REPO = "acme/agent";
const TAG_REF = `oci://${HOST}/${REPO}@1.0.0`;

let workdir: string;
let manifestsDir: string;
let reg: ReturnType<typeof mockRegistry>;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-nested-install-"));
  manifestsDir = path.join(workdir, ".telo", "manifests");
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  reg = mockRegistry();
  vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  await fs.rm(workdir, { recursive: true, force: true });
});

const pinOf = async (text: string) =>
  `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;

async function publishAndWriteApp(
  options: { byDigest?: boolean } = {},
): Promise<{ app: string; digest: string }> {
  const transport = new OciTransport();
  const chatLayers: PayloadLayer[] = [
    { role: "common", files: [{ name: "prompt.md", content: Buffer.from("be helpful") }] },
  ];
  const chat = injectLayerIndex(
    "kind: Telo.Library\nmetadata:\n  name: Chat\n---\nkind: Telo.JsonSchema\nmetadata:\n  name: Prompt\nschema:\n  type: string\n",
    await transport.layerIndex(chatLayers),
  );
  const agent = `kind: Telo.Library\nmetadata:\n  name: Agent\n  version: 1.0.0\nimports:\n  Chat: ./chat#${await pinOf(chat)}\n`;
  const result = await transport.publish(`oci://${HOST}/${REPO}`, {
    manifest: agent,
    layers: [],
    nested: [{ path: "chat/telo.yaml", manifest: chat, layers: chatLayers }],
  });
  const app = path.join(workdir, "app", "telo.yaml");
  await fs.mkdir(path.dirname(app), { recursive: true });
  const ref = options.byDigest ? `oci://${HOST}/${REPO}@${result.digest}` : TAG_REF;
  await fs.writeFile(
    app,
    `kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Agent: ${ref}#${await pinOf(agent)}\n`,
  );
  return { app, digest: result.digest! };
}

async function loadGraph(app: string) {
  const loader = new Loader([new LocalFileSource(), ...defaultTransportRegistry().sources()]);
  const graph = await loader.loadGraph(app, { desugarImports: true, migrate: true });
  expect(graph.errors).toEqual([]);
  return graph;
}

describe("install over an artifact with a nested library", () => {
  it("records the parent's digest, warms the nested layers, and then loads offline", async () => {
    const { app, digest } = await publishAndWriteApp();
    const entryDir = path.dirname(app);
    const graph = await loadGraph(app);

    await writeManifestCache(graph, entryDir, manifestsDir);
    await writeNestedOriginDigests(graph, manifestsDir);
    const warmed = await warmModuleLayers(graph, entryDir, manifestsDir, hostPlatformTarget());
    expect(warmed.gaps).toEqual([]);

    expect((await readOriginDigests(manifestsDir)).get(`${HOST}/${REPO}@1.0.0`)).toBe(digest);
    const parentDir = path.join(manifestsDir, "oci", HOST, ...REPO.split("/"), "1.0.0");
    expect(await fs.readFile(path.join(parentDir, "chat", "prompt.md"), "utf-8")).toBe("be helpful");

    reg.offline();
    const kernel = new Kernel({
      env: {},
      sources: [new LocalFileSource(), new LocalManifestCacheSource(entryDir, manifestsDir)],
    });
    await kernel.load(app, { cacheDir: path.join(workdir, ".telo") });
    expect(kernel.getLoadedGraph()).toBeDefined();
  });

  it("records nothing for a parent imported by digest, which is its own identity", async () => {
    const { app } = await publishAndWriteApp({ byDigest: true });
    const graph = await loadGraph(app);

    expect(await writeNestedOriginDigests(graph, manifestsDir)).toBe(0);
    expect((await readOriginDigests(manifestsDir)).size).toBe(0);
  });

  it("locates a diagnostic inside the nested module by its parent as written", async () => {
    const { app } = await publishAndWriteApp();
    const graph = await loadGraph(app);
    const location = resolveLocation(
      graph,
      { message: "x", data: { resource: { kind: "Telo.JsonSchema", name: "Prompt" } } },
      app,
    );
    expect(location).toMatch(/^oci:\/\/reg\.test\/acme\/agent@1\.0\.0, nested module 'chat':\d+:\d+$/);
  });
});

describe("telo package over an artifact with a nested library", () => {
  it("carries the parent's digest record and the nested library's layers", async () => {
    const { app, digest } = await publishAndWriteApp();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workdir);
    const { payload } = await buildAppPayload({
      manifestPath: app,
      platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
      report: () => {},
    });
    cwd.mockRestore();

    const unpacked = path.join(workdir, "unpacked");
    await unpackPayload(payload, unpacked);
    const manifests = path.join(unpacked, "cache", "manifests");
    expect((await readOriginDigests(manifests)).get(`${HOST}/${REPO}@1.0.0`)).toBe(digest);
    const parentDir = path.join(manifests, "oci", HOST, ...REPO.split("/"), "1.0.0");
    expect(await fs.readFile(path.join(parentDir, "chat", "prompt.md"), "utf-8")).toBe("be helpful");
  }, 60_000);
});

describe("a cache any command populates loads offline", () => {
  async function loadsOffline(app: string): Promise<void> {
    reg.offline();
    const kernel = new Kernel({
      env: {},
      sources: [
        new LocalFileSource(),
        new LocalManifestCacheSource(path.dirname(app), manifestsDir),
      ],
    });
    await kernel.load(app, { cacheDir: path.join(workdir, ".telo") });
    expect(kernel.getLoadedGraph()).toBeDefined();
  }

  it("after telo run", async () => {
    const { app, digest } = await publishAndWriteApp();
    const kernel = new Kernel({
      env: {},
      sources: [new LocalFileSource(), ...defaultTransportRegistry().sources()],
    });
    await kernel.load(app, { cacheDir: path.join(workdir, ".telo") });

    await persistManifestCache(
      { cacheWrite: true, path: app } as never,
      kernel,
      createLogger(false),
      path.join(workdir, ".telo"),
    );

    expect((await readOriginDigests(manifestsDir)).get(`${HOST}/${REPO}@1.0.0`)).toBe(digest);
    await loadsOffline(app);
  });

  it("after telo check", async () => {
    const { app, digest } = await publishAndWriteApp();
    const input = { entryPath: app, cacheRoot: path.join(workdir, ".telo"), cacheSealed: false };
    const target = cacheTargetFor(input)!;

    await checkOne(input, openSession([target]), true, createLogger(false));

    expect((await readOriginDigests(manifestsDir)).get(`${HOST}/${REPO}@1.0.0`)).toBe(digest);
    await loadsOffline(app);
  });
});

describe("--pin-local", () => {
  it("leaves an import of a library below the importer untouched, even when it is a workspace module", async () => {
    await fs.writeFile(
      path.join(workdir, "telo-workspace.yaml"),
      "release:\n  modules:\n    - examples/app/chat\n",
    );
    const chatDir = path.join(workdir, "examples", "app", "chat");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(chatDir, "telo.yaml"),
      "kind: Telo.Library\nmetadata:\n  name: Chat\n  version: 1.0.0\n",
    );
    const pinner = new LocalImportPinner({ rungs: {} as never });
    expect(await pinner.verdictFor(path.join(workdir, "examples", "app"), "./chat")).toEqual({
      kind: "unmanaged",
    });
  });
});

import { sha256Base64Url } from "@telorun/analyzer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { injectLayerIndex } from "../src/bundle/files-integrity.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import {
  LocalManifestCacheSource,
  writeManifestCache,
} from "../src/manifest-sources/local-manifest-cache-source.js";
import { writeOriginDigests } from "../src/manifest-sources/origin-digests.js";
import { OciTransport } from "../src/transports/oci/oci-transport.js";
import type { PayloadLayer } from "../src/transports/transport.js";
import { mockRegistry } from "./mock-oci-registry.js";

/**
 * A library shipped inside its importer's artifact (`kernel/specs/module-artifact.md`
 * §6), read by the kernel over the mock registry: the artifact is published as
 * `telo publish` does for a root with a nested `./chat` directory library and a
 * nested `./ordering.yaml` file library.
 */

const HOST = "reg.test";
const REPO = "acme/agent";
const TAG_REF = `oci://${HOST}/${REPO}@1.0.0`;

const pinOf = async (text: string) =>
  `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;

const CHAT = [
  "kind: Telo.Library",
  "metadata:",
  "  name: Chat",
  "---",
  "kind: Telo.JsonSchema",
  "metadata:",
  "  name: Prompt",
  "schema:",
  "  type: string",
  "  description: !include-text prompt.md",
  "",
].join("\n");
const ORDERING = "kind: Telo.Library\nmetadata:\n  name: Ordering\n";

interface Published {
  digest: string;
  pin: string;
  /** `blob` of each payload layer, by owner. */
  blobs: { agent: string; chat: string };
}

let workdir: string;
let cacheRoot: string;
let manifestsDir: string;
let reg: ReturnType<typeof mockRegistry>;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-nested-"));
  cacheRoot = path.join(workdir, ".telo");
  manifestsDir = path.join(cacheRoot, "manifests");
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  reg = mockRegistry();
  vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  await fs.rm(workdir, { recursive: true, force: true });
});

/** Publish the agent at `1.0.0`. `chatPinnedAs` is the chat text the agent's
 *  pin is taken over (the shipped one by default); `nested: false` publishes the
 *  agent's relative import with no module in the manifest layer. */
async function publishAgent(opts: {
  chat?: string;
  /** `null` ships chat with no layers of its own. */
  prompt?: string | null;
  chatPinnedAs?: string;
  nested?: boolean;
}): Promise<Published> {
  const transport = new OciTransport();
  const chatLayers: PayloadLayer[] =
    opts.prompt === null
      ? []
      : [{ role: "common", files: [{ name: "prompt.md", content: Buffer.from(opts.prompt ?? "be helpful") }] }];
  const chatIndex = await transport.layerIndex(chatLayers);
  const withIndex = (text: string) => (chatIndex.length > 0 ? injectLayerIndex(text, chatIndex) : text);
  const chat = withIndex(opts.chat ?? CHAT);
  const agentLayers: PayloadLayer[] = [
    { role: "common", files: [{ name: "agent.txt", content: Buffer.from("the agent's own file") }] },
  ];
  const agentIndex = await transport.layerIndex(agentLayers);
  const chatPin = await pinOf(
    opts.chatPinnedAs === undefined ? chat : withIndex(opts.chatPinnedAs),
  );
  const agent = injectLayerIndex(
    [
      "kind: Telo.Library",
      "metadata:",
      "  name: Agent",
      "  version: 1.0.0",
      "imports:",
      `  Chat: ./chat#${chatPin}`,
      ...(opts.nested === false ? [] : [`  Ordering: ./ordering.yaml#${await pinOf(ORDERING)}`]),
      "",
    ].join("\n"),
    agentIndex,
  );
  const result = await transport.publish(`oci://${HOST}/${REPO}`, {
    manifest: agent,
    layers: agentLayers,
    nested:
      opts.nested === false
        ? []
        : [
            { path: "chat/telo.yaml", manifest: chat, layers: chatLayers },
            { path: "ordering.yaml", manifest: ORDERING, layers: [] },
          ],
  });
  return {
    digest: result.digest!,
    pin: await pinOf(agent),
    blobs: { agent: agentIndex[0].blob, chat: chatIndex[0]?.blob ?? "" },
  };
}

/** The application importing the agent by tag, pinned. */
async function writeApp(pin: string): Promise<string> {
  const file = path.join(workdir, "app", "telo.yaml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `kind: Telo.Application\nmetadata:\n  name: App\nimports:\n  Agent: ${TAG_REF}#${pin}\n`,
  );
  return file;
}

function kernel(): Kernel {
  return new Kernel({
    env: {},
    sources: [new LocalFileSource(), new LocalManifestCacheSource("", manifestsDir)],
  });
}

function sourceNamed(k: Kernel, name: string): string {
  const graph = k.getLoadedGraph()!;
  for (const [source, mod] of graph.modules) {
    const doc = mod.owner.manifests.find((m) => m?.kind === "Telo.Library");
    if (doc?.metadata?.name === name) return source;
  }
  throw new Error(`no module named ${name}`);
}

const agentDir = () => path.join(manifestsDir, "oci", HOST, ...REPO.split("/"), "1.0.0");

describe("a library shipped inside an artifact loaded by tag", () => {
  it("is identified by the artifact's digest, and its files come from its own layers on first use", async () => {
    const published = await publishAgent({});
    const k = kernel();
    await k.load(await writeApp(published.pin), { cacheDir: cacheRoot });

    expect(sourceNamed(k, "Chat")).toBe(`oci://${HOST}/${REPO}@${published.digest}/chat`);
    expect(sourceNamed(k, "Ordering")).toBe(`oci://${HOST}/${REPO}@${published.digest}/ordering.yaml`);
    // Reading the manifests fetched no payload layer — the parent's or chat's.
    expect(reg.blobPulls()).not.toContain(published.blobs.chat);
    expect(reg.blobPulls()).not.toContain(published.blobs.agent);

    const chatSource = sourceNamed(k, "Chat");
    await k.start();
    expect(k.exitCode).toBe(0);
    // `!include-text prompt.md` materialized chat's own layer into chat's
    // directory inside the parent's tree, and nothing of the parent's payload.
    expect(k.getModuleArtifact(chatSource)?.directory).toBe(path.join(agentDir(), "chat"));
    expect(await fs.readFile(path.join(agentDir(), "chat", "prompt.md"), "utf-8")).toBe("be helpful");
    expect(reg.blobPulls()).toContain(published.blobs.chat);
    expect(reg.blobPulls()).not.toContain(published.blobs.agent);
  });

  it("names its parent by the tag it was loaded by in a diagnostic raised inside it", async () => {
    const published = await publishAgent({ chat: `${ORDERING.replace("Ordering", "Chat")}---\nkind: [\n`, prompt: null });
    await expect(kernel().load(await writeApp(published.pin), { cacheDir: cacheRoot })).rejects.toThrow(
      `${TAG_REF}, nested module 'chat': `,
    );
  });

  it("is refused as a pin mismatch when its manifest in the manifest layer was altered", async () => {
    const published = await publishAgent({ chatPinnedAs: CHAT.replace("Prompt", "Original") });
    await expect(kernel().load(await writeApp(published.pin), { cacheDir: cacheRoot })).rejects.toThrow(
      `Integrity check failed for ${TAG_REF}, nested module 'chat'`,
    );
  });

  it("resolves a relative import the manifest layer carries no module for to a separate artifact", async () => {
    const published = await publishAgent({ nested: false });
    await new OciTransport().publish(`oci://${HOST}/${REPO}/chat`, {
      manifest: "kind: Telo.Library\nmetadata:\n  name: Chat\n  version: latest\n",
      layers: [],
    });
    const k = kernel();
    await k.load(await writeApp(published.pin), { cacheDir: cacheRoot });
    expect(sourceNamed(k, "Chat")).toBe(`oci://${HOST}/${REPO}/chat@latest`);
  });

  it("loads the chat of the artifact the tag names now after the tag moved, with the first one cached", async () => {
    const first = await publishAgent({});
    const firstKernel = kernel();
    await firstKernel.load(await writeApp(first.pin), { cacheDir: cacheRoot });
    await writeManifestCache(firstKernel.getLoadedGraph()!, workdir, manifestsDir);

    const moved = await publishAgent({ chat: CHAT.replace("Prompt", "Moved") });
    expect(moved.digest).not.toBe(first.digest);
    // What `telo check` does with a cached copy whose tag moved.
    await fs.rm(path.join(agentDir(), "telo.yaml"));

    const k = kernel();
    await k.load(await writeApp(moved.pin), { cacheDir: cacheRoot });
    const chat = sourceNamed(k, "Chat");
    expect(chat).toBe(`oci://${HOST}/${REPO}@${moved.digest}/chat`);
    expect(k.getLoadedGraph()!.modules.get(chat)!.owner.text).toContain("name: Moved");
  });
});

describe("a library nested inside a nested library", () => {
  it("has one identity whether the library beside it or the one inside it imports it", async () => {
    const lib = (name: string, imports = "") =>
      `kind: Telo.Library\nmetadata:\n  name: ${name}\n${imports}`;
    const inner = lib("Inner");
    const p = lib("P", `imports:\n  Inner: ./inner#${await pinOf(inner)}\n`);
    const q = lib("Q", `imports:\n  Inner: ../p/inner#${await pinOf(inner)}\n`);
    const agent = lib(
      "Agent",
      `imports:\n  P: ./p#${await pinOf(p)}\n  Q: ./q#${await pinOf(q)}\n`,
    ).replace("name: Agent\n", "name: Agent\n  version: 1.0.0\n");
    await new OciTransport().publish(`oci://${HOST}/${REPO}`, {
      manifest: agent,
      layers: [],
      nested: [
        { path: "p/telo.yaml", manifest: p, layers: [] },
        { path: "p/inner/telo.yaml", manifest: inner, layers: [] },
        { path: "q/telo.yaml", manifest: q, layers: [] },
      ],
    });

    const k = kernel();
    await k.load(await writeApp(await pinOf(agent)), { cacheDir: cacheRoot });

    const graph = k.getLoadedGraph()!;
    const innerSources = [...graph.modules]
      .filter(([, mod]) => mod.owner.manifests.some((m) => m?.kind === "Telo.Library" && m.metadata?.name === "Inner"))
      .map(([source]) => source);
    expect(innerSources).toHaveLength(1);
    expect(innerSources[0]).toMatch(new RegExp(`^oci://${HOST}/${REPO}@sha256:[0-9a-f]+/p/inner$`));
    expect(sourceNamed(k, "Q")).toMatch(/\/q$/);
  });
});

describe("a library shipped inside an artifact served from the manifest cache", () => {
  async function warm(): Promise<Published> {
    const published = await publishAgent({});
    const k = kernel();
    await k.load(await writeApp(published.pin), { cacheDir: cacheRoot });
    await writeManifestCache(k.getLoadedGraph()!, workdir, manifestsDir);
    reg.offline();
    return published;
  }

  it("is refused offline, naming the parent and `telo install`, when no digest was recorded for the copy", async () => {
    const published = await warm();
    const failure = kernel().load(await writeApp(published.pin), { cacheDir: cacheRoot });
    await expect(failure).rejects.toThrow(`${TAG_REF} was served from the manifest cache`);
    await expect(failure).rejects.toThrow("run `telo install`");
  });

  it("loads offline from the copy of the digest the record names", async () => {
    const published = await warm();
    await writeOriginDigests(manifestsDir, new Map([[`${HOST}/${REPO}@1.0.0`, published.digest]]));
    const k = kernel();
    await k.load(await writeApp(published.pin), { cacheDir: cacheRoot });
    const mirror = path.join(manifestsDir, "oci", HOST, ...REPO.split("/"), published.digest.replace(":", "-"));
    expect(sourceNamed(k, "Chat")).toBe(pathToFileURL(path.join(mirror, "chat", "telo.yaml")).href);
    expect(sourceNamed(k, "Ordering")).toBe(pathToFileURL(path.join(mirror, "ordering.yaml")).href);
  });
});

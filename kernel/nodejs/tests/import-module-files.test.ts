import { sha256Base64Url } from "@telorun/analyzer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { injectLayerIndex } from "../src/bundle/files-integrity.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { LocalManifestCacheSource } from "../src/manifest-sources/local-manifest-cache-source.js";
import { OciTransport } from "../src/transports/oci/oci-transport.js";
import type { PayloadLayer } from "../src/transports/transport.js";
import { mockRegistry } from "./mock-oci-registry.js";

/**
 * A published library handing a library nested in its artifact one of its own
 * module files (`!module-path ./a` at the import's `variables:`): the path is
 * the published library's directory, materialized from its own layer, and held
 * to the `entry` the nested library declares — a judgement no analysis of the
 * entry makes, since the import is the artifact's own.
 */

const HOST = "reg.test";
const REPO = "acme/agent";

const pinOf = async (text: string) =>
  `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;

const chatDeclaring = (rootType: string) => [
  "kind: Telo.Library",
  "metadata:",
  "  name: Chat",
  "variables:",
  `  root: { type: string, x-telo-type: ${rootType} }`,
  "exports: { resources: [read] }",
  "---",
  "kind: Telo.Value",
  "metadata:",
  "  name: read",
  'value: !cel "string(variables.root)"',
  "",
].join("\n");
const CHAT = chatDeclaring("Telo.HostPath");

let workdir: string;
let manifestsDir: string;

beforeEach(async () => {
  // Real path: Windows names the temp directory by its 8.3 short form, whose
  // `~` the module URL encodes and the test runner's loader does not decode.
  workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-import-module-files-")));
  manifestsDir = path.join(workdir, ".telo", "manifests");
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  vi.spyOn(globalThis, "fetch").mockImplementation(mockRegistry().impl);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  await fs.rm(workdir, { recursive: true, force: true });
});

/** Run an application reading the nested library's `read`, refused unless it
 *  equals `expected`. */
async function exitCodeReading(
  expected: (agentDir: string) => string,
  chat: string = CHAT,
): Promise<number | undefined> {
  const transport = new OciTransport();
  const agentLayers: PayloadLayer[] = [
    { role: "common", files: [{ name: "a/README.md", content: Buffer.from("the agent's own directory") }] },
  ];
  const agent = injectLayerIndex(
    [
      "kind: Telo.Library",
      "metadata:",
      "  name: Agent",
      "  version: 1.0.0",
      "imports:",
      "  Chat:",
      `    source: ./chat#${await pinOf(chat)}`,
      "    variables: { root: !module-path ./a }",
      "exports: { resources: [Chat.read] }",
      "",
    ].join("\n"),
    await transport.layerIndex(agentLayers),
  );
  await transport.publish(`oci://${HOST}/${REPO}`, {
    manifest: agent,
    layers: agentLayers,
    nested: [{ path: "chat/telo.yaml", manifest: chat, layers: [] }],
  });
  const app = path.join(workdir, "app", "telo.yaml");
  await fs.mkdir(path.dirname(app), { recursive: true });
  await fs.writeFile(
    app,
    [
      "kind: Telo.Application",
      "metadata: { name: App }",
      "variables: { expected: { env: EXPECTED, type: string } }",
      "imports:",
      `  Agent: oci://${HOST}/${REPO}@1.0.0#${await pinOf(agent)}`,
      "targets: [!ref check]",
      "---",
      "kind: Telo.Sequence",
      "metadata: { name: check }",
      "steps:",
      "  - { name: read, invoke: !ref Agent.read }",
      "  - name: compare",
      '    if: !cel "steps.read.result != variables.expected"',
      "    then:",
      '      - { name: differs, throw: { code: WRONG_PATH, message: !cel "steps.read.result" } }',
      "",
    ].join("\n"),
  );
  const agentDir = path.join(manifestsDir, "oci", HOST, ...REPO.split("/"), "1.0.0");
  const kernel = new Kernel({
    env: { EXPECTED: expected(agentDir) },
    sources: [new LocalFileSource(), new LocalManifestCacheSource("", manifestsDir)],
  });
  await kernel.load(app, { cacheDir: path.join(workdir, ".telo") });
  await kernel.start();
  return kernel.exitCode;
}

it("hands a nested library the published library's own directory, not its own", async () => {
  expect(await exitCodeReading((agentDir) => path.join(agentDir, "a"))).toBe(0);
});


it("refuses a nested library's file input handed a directory", async () => {
  const error = await exitCodeReading(
    (agentDir) => path.join(agentDir, "a"),
    chatDeclaring("{ name: Telo.HostPath, entry: file }"),
  ).catch((e: Error) => e);
  expect(String((error as Error).message)).toMatch(
    /Telo\.Import Chat: RuntimeError: Import 'Chat': variables: '\/root' takes the path of a file, but '[^']*[\\/]a' is a directory\. \[ERR_HOST_PATH_ENTRY_MISMATCH\]/,
  );
});

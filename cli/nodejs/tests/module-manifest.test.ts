import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAnalyzedGraph } from "../src/analyzed-graph.js";
import { analysedRequirements, buildManifestJsonPayload } from "../src/commands/module.js";
import { createLogger } from "../src/logger.js";

/** The contract `telo module manifest --json` owes the hub's tracker.
 *
 *  Asserted here rather than in the hub e2e because that suite cannot see it:
 *  the hub container tracks with the `telo` its base image ships, so a field
 *  added to this command is invisible there until a CLI release lands and
 *  TELO_NODE_VERSION is bumped. This is the coverage for the CLI half of
 *  CLI → column → route. */

const log = createLogger(false);
const MANIFEST = "kind: Telo.Library\nmetadata:\n  name: Console\n  version: 0.9.0\n";

/** Two kinds with different controller coverage, so the roll-up has something
 *  to disagree about — a module where every kind matched would pass even if the
 *  per-kind classification were dropped entirely. */
const KIND_MANIFEST = `${MANIFEST}---
kind: Telo.Definition
metadata:
  name: WriteLine
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/writeline.mjs
  - pkg:cargo/telorun-console?local_path=./rust#writeline_controller
---
kind: Telo.Definition
metadata:
  name: WriteStream
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/writestream.mjs
`;

function stubFetch(impl: () => { ok: boolean; body?: string }): void {
  vi.stubGlobal("fetch", async () => {
    const r = impl();
    return {
      ok: r.ok,
      status: r.ok ? 200 : 404,
      statusText: r.ok ? "OK" : "Not Found",
      arrayBuffer: async () => new TextEncoder().encode(r.body ?? "").buffer,
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

/** A library and the built-in vocabulary are reported from their text alone. */
const NOT_ANALYSED = async (): Promise<never> => {
  throw new Error("only an Application's graph is analysed");
};

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The payload of `manifest` written to a directory of its own, its
 *  requirements from its analysed graph, as the command builds it. */
async function applicationPayload(manifest: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-module-manifest-"));
  temporary.push(dir);
  const file = path.join(dir, "telo.yaml");
  fs.writeFileSync(file, manifest);
  return buildManifestJsonPayload(file, manifest, log, () => analysedRequirements(file, log));
}

const CONFIGURATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/configurations",
);

describe("buildManifestJsonPayload", () => {
  it("carries the import pin for a resolvable remote ref", async () => {
    stubFetch(() => ({ ok: true, body: MANIFEST }));

    const payload = await buildManifestJsonPayload(
      "https://reg.example.test/console/telo.yaml",
      MANIFEST,
      log, NOT_ANALYSED);

    // The exact form an `imports:` entry carries as a `#sha256-…` fragment, and
    // the form the analyzer's `isCanonicalIntegrity` will accept before an
    // editor writes it into a manifest.
    expect(payload.integrity).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/);
    expect(payload.manifest).toBe(MANIFEST);
    expect(payload.cacheKey).toBe("url/reg.example.test/console/0.9.0/telo.yaml");
  });

  it("reports null with the reason on stderr when the ref cannot be hashed", async () => {
    stubFetch(() => ({ ok: false }));
    // The warning goes through the `Output` seam, which writes to the stream
    // directly — `--json` puts the payload on stdout, so the reason must not
    // land there beside it.
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);

    const payload = await buildManifestJsonPayload(
      "https://reg.example.test/console/telo.yaml",
      MANIFEST,
      log, NOT_ANALYSED);

    // Degrades rather than failing the command — the manifest itself resolved —
    // but never silently: "nothing owns this ref", an auth rejection and a
    // network blip are different problems and must not collapse into a bare
    // null the tracker stores without explanation.
    expect(payload.integrity).toBeNull();
    expect(payload.manifest).toBe(MANIFEST);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("no integrity hash");
    stderr.mockRestore();
  });

  it("reports no runtime reach and no application for the built-in vocabulary", async () => {
    // Every kind there is implemented by the runtime itself, so no PURL names a
    // host — read as kinds, each would report as portable.
    const archive = `kind: Telo.Builtins
metadata:
  name: Telo
  version: 0.119.0
  license: MIT
---
kind: Telo.Definition
metadata:
  name: JsonSchema
capability: Telo.Type
`;
    stubFetch(() => ({ ok: true, body: archive }));

    const payload = await buildManifestJsonPayload("https://reg.example.test/telo/telo.yaml", archive, log, NOT_ANALYSED);

    expect(payload.manifest).toBe(archive);
    expect(payload.runtime).toBeNull();
    expect(payload.application).toBeNull();
  });

  it("carries the runtime classification the tracker stores without parsing a PURL", async () => {
    stubFetch(() => ({ ok: true, body: KIND_MANIFEST }));

    const payload = await buildManifestJsonPayload(
      "https://reg.example.test/console/telo.yaml",
      KIND_MANIFEST,
      log, NOT_ANALYSED);

    expect(payload.runtime!.runtimes).toEqual({ nodejs: "full", rust: "partial" });
    expect(payload.runtime!.kinds).toEqual([
      { name: "WriteLine", runtimes: ["nodejs", "rust"], languages: ["javascript", "rust"], portable: false },
      { name: "WriteStream", runtimes: ["nodejs"], languages: ["javascript"], portable: false },
    ]);
  });

  it("reports a need type as hosted by the kernels serving need types", async () => {
    const manifest = `${MANIFEST}---
kind: Telo.Definition
metadata:
  name: Open
capability: Telo.Invocable
controllers:
  - pkg:cargo/telorun-console?local_path=./rust#open
---
kind: Telo.NeedType
metadata:
  name: Access
fields:
  url: { type: string }
`;
    stubFetch(() => ({ ok: true, body: manifest }));

    const payload = await buildManifestJsonPayload(
      "https://reg.example.test/console/telo.yaml",
      manifest,
      log, NOT_ANALYSED);

    expect(payload.runtime!.runtimes).toEqual({ nodejs: "full", rust: "partial" });
    expect(payload.runtime!.kinds).toEqual([
      { name: "Open", runtimes: ["nodejs", "rust"], languages: ["rust"], portable: false },
      { name: "Access", runtimes: ["nodejs"], languages: [], portable: false },
    ]);
  });

  it("reports the platforms and ABIs a module's native: entries cover, beside its kinds", async () => {
    const manifest = [
      "kind: Telo.Library",
      "metadata:",
      "  name: SQLite",
      "  version: 1.0.0",
      "native:",
      "  - { name: addon, format: node, os: linux, arch: amd64, libc: musl, abi: node-141, path: ./n/a.node }",
      "  - { name: addon, format: node, os: linux, arch: amd64, libc: gnu, abi: node-137, path: ./n/b.node }",
      "  - { name: addon, format: node, os: linux, arch: amd64, libc: gnu, abi: node-141, path: ./n/c.node }",
      "  - { name: addon, format: node, os: darwin, arch: arm64, abi: node-137, path: ./n/d.node }",
      "",
    ].join("\n");

    const payload = await buildManifestJsonPayload("./sqlite", manifest, log, NOT_ANALYSED);

    expect(payload.runtime!.native).toEqual({
      platforms: [
        { os: "darwin", arch: "arm64" },
        { os: "linux", arch: "amd64", libc: "gnu" },
        { os: "linux", arch: "amd64", libc: "musl" },
      ],
      abis: ["node-137", "node-141"],
    });
  });

  it("reports an Application's declared inputs in declaration order", async () => {
    const manifest = [
      "kind: Telo.Application",
      "metadata:",
      "  name: HelloApp",
      "  version: 0.1.0",
      "variables:",
      "  greeting:",
      "    type: string",
      "    description: What to say",
      "    default: hello",
      "    env: GREETING",
      "    arg: { flag: greeting, short: g }",
      "    minLength: 1",
      "  name:",
      "    type: string",
      "    env: NAME",
      "    arg: { position: 0 }",
      "secrets:",
      "  apiKey:",
      "    type: string",
      "    env: API_KEY",
      "ports:",
      "  http:",
      "    env: PORT",
      "    default: 8080",
      "    arg: port",
      "",
    ].join("\n");

    const payload = await applicationPayload(manifest);

    // Nothing reads an input, so no configuration requires one; a default is
    // reported exactly where one is declared.
    expect(payload!.application).toEqual({
      variables: [
        {
          name: "greeting",
          description: "What to say",
          required: false,
          env: "GREETING",
          default: "hello",
          arg: { form: "flag", flag: "greeting", short: "g" },
          schema: { type: "string", minLength: 1 },
        },
        {
          name: "name",
          description: "",
          required: false,
          env: "NAME",
          arg: { form: "position", position: 0 },
          schema: { type: "string" },
        },
      ],
      secrets: [{ name: "apiKey", description: "", required: false, env: "API_KEY", schema: { type: "string" } }],
      ports: [
        {
          name: "http",
          description: "",
          required: false,
          env: "PORT",
          default: 8080,
          arg: { form: "flag", flag: "port", short: "" },
          protocol: "tcp",
        },
      ],
      dimensions: [],
    });
  });

  it("reports which configurations require each input, and the dimensions they are keyed by", async () => {
    const file = path.join(CONFIGURATIONS, "requirements/provider.yaml");
    const payload = await buildManifestJsonPayload(file, fs.readFileSync(file, "utf8"), log, () =>
      analysedRequirements(file, log),
    );
    expect(payload!.application!.secrets).toEqual([
      { name: "openaiApiKey", description: "", required: false, env: "OPENAI_API_KEY", schema: { type: "string" } },
      {
        name: "anthropicApiKey",
        description: "",
        required: true,
        requiredWhen: [{ "secrets.openaiApiKey": "absent" }],
        env: "ANTHROPIC_API_KEY",
        schema: { type: "string" },
      },
    ]);
    expect(payload!.application!.dimensions).toEqual([
      { key: "secrets.openaiApiKey", values: ["present", "absent"], env: ["OPENAI_API_KEY"] },
    ]);
  });

  it("reports the requirements telo describe reports for the same application", async () => {
    const file = path.join(CONFIGURATIONS, "needs/database.yaml");
    const analyzed = (await loadAnalyzedGraph(file, log))!;
    const options = { root: analyzed.root!, entryModule: analyzed.root!.metadata!.name as string };
    const outline = analyzed.registry
      .analysisOf(analyzed.manifests)
      .outline(analyzed.registry.moduleGraphDeps(analyzed.manifests, options), options);
    const requirements = (await analysedRequirements(file, log))!;
    const data = outline.inputs.find((input) => input.block === "needs" && input.name === "data")!;
    const derived = requirements.inputs.find((input) => input.block === "needs" && input.name === "data")!;
    expect({ required: data.required, requiredWhen: data.requiredWhen }).toEqual({
      required: derived.required,
      requiredWhen: derived.requiredWhen,
    });
    expect(data.requiredWhen).toEqual([{ "resources.databaseAccess": "absent" }]);
  });

  it("prints no payload for an Application its analysis refuses, naming the refusal", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    const manifest = "kind: Telo.Application\nmetadata:\n  name: Broken\n---\nkind: Nope.Thing\nmetadata: { name: thing }\n";
    const payload = await applicationPayload(manifest);
    expect(payload).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("Nope.Thing");
    stderr.mockRestore();
    process.exitCode = 0;
  });

  it("reports no application for a library", async () => {
    const payload = await buildManifestJsonPayload("./console", MANIFEST, log, NOT_ANALYSED);
    expect(payload.application).toBeNull();
  });

  it("carries no value of a secret anywhere beside the manifest text itself", async () => {
    const manifest = [
      "kind: Telo.Application",
      "metadata:",
      "  name: HelloApp",
      "  version: 0.1.0",
      "secrets:",
      "  token:",
      "    type: string",
      "    env: TOKEN",
      "    default: default-token-value",
      "    examples: [example-token-value]",
      "    enum: [default-token-value, enum-token-value]",
      "",
    ].join("\n");

    const payload = await applicationPayload(manifest);

    expect(payload!.application?.secrets).toEqual([
      { name: "token", description: "", required: false, env: "TOKEN", schema: { type: "string" } },
    ]);
    const derived = JSON.stringify({ ...payload, manifest: undefined });
    expect(derived).not.toMatch(/token-value/);
  });

  it("has neither a pin nor a cache key for a local module", async () => {
    stubFetch(() => {
      throw new Error("a local ref must not reach the network");
    });

    const payload = await buildManifestJsonPayload("./some/module", MANIFEST, log, NOT_ANALYSED);

    expect(payload).toMatchObject({ integrity: null, cacheKey: null, manifest: MANIFEST });
  });
});

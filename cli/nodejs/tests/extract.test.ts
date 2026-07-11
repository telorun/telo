import { IntegrityError, type LoadedGraph } from "@telorun/analyzer";
import { makeTarGz } from "@telorun/kernel";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractModuleBundles } from "../src/bundle/extract.js";

const REGISTRY = "https://reg.example";
const SOURCE = `${REGISTRY}/std/demo/1.0.0/telo.yaml`;
const TAR_URL = `${REGISTRY}/std/demo/1.0.0/module.tar.gz`;

let manifestsDir: string;

beforeEach(() => {
  manifestsDir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-extract-test-"));
});

afterEach(() => {
  fs.rmSync(manifestsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Minimal LoadedGraph carrying one remote module that declares `files:`.
 *  `requestedUrl` is the pinned/remote ref the transport fetches by. */
function graphWithDemo(files: string[] | undefined): LoadedGraph {
  const owner = {
    source: SOURCE,
    requestedUrl: SOURCE,
    text: "",
    documents: [],
    manifests: [{ kind: "Telo.Application", metadata: { name: "demo" }, files }],
    positions: [],
    parseErrors: [],
  };
  return {
    modules: new Map([[SOURCE, { owner, partials: [] }]]),
  } as unknown as LoadedGraph;
}

function manifestYaml(filesIntegrity?: string): string {
  return (
    "kind: Telo.Application\nmetadata:\n  name: demo\nfiles:\n  - public/**\n" +
    (filesIntegrity ? `filesIntegrity: ${filesIntegrity}\n` : "")
  );
}

/** Mock `fetch` for the two-GET artifact retrieval: telo.yaml then module.tar.gz. */
function mockArtifact(tar: Buffer, filesIntegrity?: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/telo.yaml")) {
      return Promise.resolve(new Response(manifestYaml(filesIntegrity), { status: 200 }));
    }
    if (url.endsWith("/module.tar.gz")) {
      return Promise.resolve(new Response(tar, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

async function tarGzFixture(): Promise<Buffer> {
  return makeTarGz([
    { name: "telo.yaml", content: manifestYaml() },
    { name: "public/index.html", content: "<h1>hi</h1>" },
  ]);
}

describe("extractModuleBundles", () => {
  it("fetches (telo.yaml + module.tar.gz) and extracts the payload", async () => {
    const tar = await tarGzFixture();
    const fetchSpy = mockArtifact(tar);

    const count = await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});

    expect(count).toBe(1);
    const fetched = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(fetched).toContain(SOURCE);
    expect(fetched).toContain(TAR_URL);
    const moduleDir = path.join(manifestsDir, "std", "demo", "1.0.0");
    expect(fs.readFileSync(path.join(moduleDir, "public", "index.html"), "utf-8")).toBe("<h1>hi</h1>");
  });

  it("extracts once — a second run skips the fetch (extract-once marker)", async () => {
    const tar = await tarGzFixture();
    const fetchSpy = mockArtifact(tar);

    await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});
    const callsAfterFirst = fetchSpy.mock.calls.length;
    const count2 = await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});

    expect(count2).toBe(0);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("skips modules without a files: declaration (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const count = await extractModuleBundles(graphWithDemo(undefined), "", REGISTRY, manifestsDir, () => {});
    expect(count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a tar entry that escapes the module directory", async () => {
    const evil = await makeTarGz([{ name: "../escape.txt", content: "x" }]);
    mockArtifact(evil);
    await expect(
      extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {}),
    ).rejects.toThrow(/outside the module cache directory/);
  });

  it("hard-fails (never warns) on a payload integrity mismatch", async () => {
    const tar = await tarGzFixture();
    mockArtifact(tar, "sha256-wrongwrongwrongwrongwrongwrongwrongwrong");
    const warn = vi.fn();
    await expect(
      extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, warn),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and skips on a transient bundle fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/telo.yaml")) {
        return Promise.resolve(new Response(manifestYaml(), { status: 200 }));
      }
      return Promise.resolve(new Response("nope", { status: 503 }));
    });
    const warn = vi.fn();
    const count = await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, warn);
    expect(count).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

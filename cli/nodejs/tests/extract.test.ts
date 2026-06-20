import type { LoadedGraph } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractModuleBundles } from "../src/bundle/extract.js";
import { makeTarGz } from "../src/bundle/tar.js";

const REGISTRY = "https://reg.example";
const SOURCE = `${REGISTRY}/std/demo/1.0.0/telo.yaml`;

let manifestsDir: string;

beforeEach(() => {
  manifestsDir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-extract-test-"));
});

afterEach(() => {
  fs.rmSync(manifestsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Minimal LoadedGraph carrying one remote module that declares `files:`. */
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

async function tarGzFixture(): Promise<Buffer> {
  return makeTarGz([
    { name: "telo.yaml", content: "kind: Telo.Application\n" },
    { name: "public/index.html", content: "<h1>hi</h1>" },
  ]);
}

describe("extractModuleBundles", () => {
  it("fetches and extracts the bundle next to the cached manifest", async () => {
    const tar = await tarGzFixture();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(tar, { status: 200 }));

    const count = await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});

    expect(count).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${REGISTRY}/std/demo/1.0.0/module.tar.gz`);
    const moduleDir = path.join(manifestsDir, "std", "demo", "1.0.0");
    expect(fs.readFileSync(path.join(moduleDir, "public", "index.html"), "utf-8")).toBe("<h1>hi</h1>");
    expect(fs.existsSync(path.join(moduleDir, "telo.yaml"))).toBe(true);
  });

  it("extracts once — a second run skips the fetch (extract-once marker)", async () => {
    const tar = await tarGzFixture();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(tar, { status: 200 }));

    await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});
    const count2 = await extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {});

    expect(count2).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips modules without a files: declaration (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const count = await extractModuleBundles(graphWithDemo(undefined), "", REGISTRY, manifestsDir, () => {});
    expect(count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a tar entry that escapes the module directory", async () => {
    const evil = await makeTarGz([{ name: "../escape.txt", content: "x" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(evil, { status: 200 }));
    await expect(
      extractModuleBundles(graphWithDemo(["public/**"]), "", REGISTRY, manifestsDir, () => {}),
    ).rejects.toThrow(/outside the module cache directory/);
  });
});

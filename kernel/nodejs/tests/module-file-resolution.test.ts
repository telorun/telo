import { readModuleSources, readNativeEntries } from "@telorun/analyzer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureStagedEntry } from "../src/bundle/source-staging.js";
import { makeTarGz } from "../src/bundle/tar.js";
import {
  resolveModuleFileUri,
  type ModuleFileLookup,
  type NativeFileModule,
} from "../src/module-file-resolution.js";

const ASSET = "./assets/ui/app.js";
const STYLE = "./assets/ui/app.css";
const ADDON = "./native/linux-amd64/addon.node";
const BYTES = "bytes";
const sha = (content: string) => createHash("sha256").update(content).digest("hex");

let server: http.Server;
let base: string;
const requests: string[] = [];

beforeAll(async () => {
  const archive = await makeTarGz([
    { name: "app.js", content: BYTES },
    { name: "app.css", content: BYTES },
    { name: "addon.node", content: BYTES },
  ]);
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/ui-1.0.0.tar.gz") res.writeHead(200).end(archive);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir: string;
let manifest: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-module-file-test-"));
  manifest = pathToFileURL(path.join(dir, "telo.yaml")).href;
  requests.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(relative: string, content: string): void {
  const abs = path.join(dir, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const pinned = (member: string, sha256 = sha(BYTES)) => ({ upstream: "ui", member, sha256, executable: false });

function stagedBy(options: { url?: string; sha256?: string } = {}) {
  return {
    ui: {
      version: "1.0.0",
      url: options.url ?? `${base}/ui-{version}.tar.gz`,
      archive: "tar.gz",
      notices: ["./LICENSE"],
      entries: { [ASSET]: pinned("app.js", options.sha256) },
    },
  };
}

function lookupFor(sources: unknown, native: unknown[] = []): ModuleFileLookup {
  const module: NativeFileModule = {
    source: manifest,
    native: readNativeEntries({ native }),
    sources: readModuleSources({ sources }),
    assetPatterns: ["./assets/"],
  };
  return {
    getModuleArtifact: () => undefined,
    getDeclaringModule: () => module,
    ensureStagedEntry: (moduleDir, source, entry, archives) =>
      ensureStagedEntry(moduleDir, source, entry, { archives }),
  };
}

describe("resolveModuleFileUri from a source checkout with staged files", () => {
  it.each([
    ["the staged file itself", ASSET],
    ["a directory the staged file sits beneath", "./assets/"],
    ["the module root", "./"],
  ])("resolves %s when the file matches its pin", async (_label, reference) => {
    writeFile(ASSET, BYTES);
    const uri = await resolveModuleFileUri(reference, manifest, lookupFor(stagedBy()));
    expect(uri).toBe(new URL(reference, manifest).href);
  });

  it.each([
    [
      "the upstream cannot provide it",
      () => stagedBy({ url: `${base}/gone-{version}.tar.gz` }),
      "its archive could not be fetched",
      "answered 404",
    ],
    [
      "its bytes do not match the pin",
      () => stagedBy({ sha256: sha("other") }),
      "its archive does not hold the pinned file",
      `hashes to sha256 ${sha(BYTES)}`,
    ],
  ])("refuses when %s, and writes nothing", async (_label, sources, kind, detail) => {
    const rejection = resolveModuleFileUri("./assets/", manifest, lookupFor(sources()));
    await expect(rejection).rejects.toMatchObject({ code: "ERR_MODULE_FILES_UNAVAILABLE" });
    await expect(rejection).rejects.toThrow(kind);
    await expect(rejection).rejects.toThrow(detail);
    expect(fs.existsSync(path.join(dir, ASSET))).toBe(false);
  });

  it("fetches an archive once for every module file a reference covers", async () => {
    const sources = stagedBy();
    const ui = sources.ui as { entries: Record<string, unknown> };
    ui.entries[STYLE] = pinned("app.css");
    await resolveModuleFileUri("./assets/", manifest, lookupFor(sources));
    expect(fs.readFileSync(path.join(dir, ASSET), "utf8")).toBe(BYTES);
    expect(fs.readFileSync(path.join(dir, STYLE), "utf8")).toBe(BYTES);
    expect(requests).toEqual(["/ui-1.0.0.tar.gz"]);
  });

  it("does not stage a native file beneath the reference, which its own resolution stages for this host", async () => {
    writeFile(ASSET, BYTES);
    const sources = stagedBy();
    const ui = sources.ui as { entries: Record<string, unknown> };
    ui.entries[ADDON] = pinned("addon.node");
    const native = [{ name: "addon", format: "napi", os: "linux", arch: "amd64", path: ADDON }];
    await resolveModuleFileUri("./", manifest, lookupFor(sources, native));
    expect(requests).toEqual([]);
    expect(fs.existsSync(path.join(dir, ADDON))).toBe(false);
  });

  it("does not stage a file outside the reference", async () => {
    writeFile("public/index.html", "<html></html>");
    const uri = await resolveModuleFileUri("./public/", manifest, lookupFor(stagedBy()));
    expect(uri).toBe(new URL("./public/", manifest).href);
    expect(fs.existsSync(path.join(dir, ASSET))).toBe(false);
  });

  it("refuses every reference while the sources: block does not read", async () => {
    writeFile("public/index.html", "<html></html>");
    const rejection = resolveModuleFileUri(
      "./public/",
      manifest,
      lookupFor(stagedBy({ url: "http://example.test/{version}/ui.tar.gz" })),
    );
    await expect(rejection).rejects.toMatchObject({ code: "ERR_MODULE_FILES_UNAVAILABLE" });
    await expect(rejection).rejects.toThrow("sources: block cannot be read");
  });
});

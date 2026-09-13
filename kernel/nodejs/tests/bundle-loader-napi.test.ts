import { readModuleSources, type ArtifactLayer } from "@telorun/analyzer";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { hostPlatformTarget, ModuleArtifact } from "../src/bundle/module-artifact.js";
import { BundleControllerLoader } from "../src/controller-loaders/bundle-loader.js";
import { ControllerEnvMissingError } from "../src/controller-loaders/napi-loader.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const host = hostPlatformTarget();
const ADDON = "native/echo.node";
const PURL = `pkg:telo/local/napi?path=./${ADDON}&os=${host.os}&arch=${host.arch}#echo`;

/** The `napi-echo` fixture crate's cdylib, built the way a prebuild is. */
function buildEchoAddon(): Buffer {
  const out = execFileSync("cargo", ["build", "--release", "--locked", "--message-format=json"], {
    cwd: path.join(here, "napi-echo"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of out.split("\n")) {
    if (!line.includes('"compiler-artifact"')) continue;
    const message = JSON.parse(line) as { target: { name: string }; filenames: string[] };
    if (message.target.name !== "napi_echo") continue;
    const dylib = message.filenames.find((file) => /\.(so|dylib|dll)$/.test(file));
    if (dylib) return fs.readFileSync(dylib);
  }
  throw new Error("cargo build produced no napi_echo cdylib");
}

describe("BundleControllerLoader napi candidates", () => {
  let dir: string;
  let addon: Buffer;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-napi-bundle-"));
    addon = buildEchoAddon();
  }, 300_000);

  afterAll(() => {
    // Windows keeps a loaded addon's file locked until the process exits.
    if (process.platform !== "win32") fs.rmSync(dir, { recursive: true, force: true });
  });

  async function echoes(instance: { create?: (...args: unknown[]) => unknown }) {
    const created = (await instance.create!({}, {})) as { invoke(input: unknown): unknown };
    return created.invoke({ text: "hi" });
  }

  it("loads a matching addon from a source checkout, selecting the fragment from its exports", async () => {
    const moduleDir = path.join(dir, "checkout");
    fs.mkdirSync(path.join(moduleDir, "native"), { recursive: true });
    fs.writeFileSync(path.join(moduleDir, ADDON), addon);

    const resolved = await new BundleControllerLoader().resolve(
      PURL,
      pathToFileURL(path.join(moduleDir, "telo.yaml")).href,
    );
    expect(resolved.source).toBe("local");
    expect(await echoes(await resolved.importInstance())).toEqual({ text: "hi" });
    // The fragment is read off the exports object, not ignored.
    const unknown = await new BundleControllerLoader().resolve(
      PURL.replace("#echo", "#absent"),
      pathToFileURL(path.join(moduleDir, "telo.yaml")).href,
    );
    await expect(unknown.importInstance()).rejects.toThrow(
      `pkg:telo controller "${PURL.replace("#echo", "#absent")}" at`,
    );
  });

  it("refuses a staged addon that does not match its pin, naming telo release stage", async () => {
    const moduleDir = path.join(dir, "stale");
    fs.mkdirSync(path.join(moduleDir, "native"), { recursive: true });
    fs.writeFileSync(path.join(moduleDir, ADDON), addon);
    const sources = readModuleSources({
      sources: {
        echo: {
          version: "1.0.0",
          url: "https://example.test/{version}/{upstream}.tar.gz",
          archive: "tar.gz",
          notices: ["./LICENSE"],
          entries: { [`./${ADDON}`]: { upstream: "x", member: "echo.node", sha256: "0".repeat(64), executable: false } },
        },
      },
    });

    const rejection = new BundleControllerLoader().resolve(
      PURL,
      pathToFileURL(path.join(moduleDir, "telo.yaml")).href,
      undefined,
      undefined,
      undefined,
      sources,
    );
    await expect(rejection).rejects.toMatchObject({ code: "ERR_STAGED_FILE_INVALID" });
    await expect(rejection).rejects.toThrow("run `telo release stage`");
  });

  it("names telo release stage for a staged addon that is absent, and refuses one a broken sources: block may stage", async () => {
    const moduleDir = path.join(dir, "unstaged");
    const block = (url: string) =>
      readModuleSources({
        sources: {
          echo: {
            version: "1.0.0",
            url,
            archive: "tar.gz",
            notices: ["./LICENSE"],
            entries: { [`./${ADDON}`]: { upstream: "x", member: "echo.node", sha256: "0".repeat(64), executable: false } },
          },
        },
      });
    const resolve = (sources: ReturnType<typeof block>) =>
      new BundleControllerLoader().resolve(
        PURL,
        pathToFileURL(path.join(moduleDir, "telo.yaml")).href,
        undefined,
        undefined,
        undefined,
        sources,
      );

    const absent = resolve(block("https://example.test/{version}/{upstream}.tar.gz"));
    await expect(absent).rejects.toBeInstanceOf(ControllerEnvMissingError);
    await expect(absent).rejects.toThrow("staged by source 'echo': run `telo release stage` to fetch it");

    const broken = resolve(block("http://example.test/{version}/{upstream}.tar.gz"));
    await expect(broken).rejects.toMatchObject({ code: "ERR_STAGED_FILE_INVALID" });
    await expect(broken).rejects.toThrow("sources: block cannot be read");
  });

  it("loads a matching addon from a published artifact's controller layer", async () => {
    const files: PayloadFile[] = [{ name: ADDON, content: addon }];
    const layer: ArtifactLayer = {
      role: "controller",
      selector: { format: "napi", os: host.os!, arch: host.arch! },
      blob: `sha256:${"a".repeat(64)}`,
      integrity: await computeFilesIntegrity(files),
    };
    const transports = { fetchLayer: async () => files } as unknown as TransportRegistry;
    const artifact = new ModuleArtifact({
      pinnedRef: "oci://reg.test/acme/echo@1.0.0#sha256-abc",
      layers: [layer],
      dir: path.join(dir, "artifact"),
      transports,
    });

    const resolved = await new BundleControllerLoader().resolve(
      PURL,
      "oci://reg.test/acme/echo@1.0.0",
      artifact,
    );
    expect(resolved.source).toBe("bundle");
    expect(await echoes(await resolved.importInstance())).toEqual({ text: "hi" });
  });

  it.each([
    ["a missing addon", `pkg:telo/local/napi?path=./native/absent.node&os=${host.os}&arch=${host.arch}#echo`],
    ["another platform's addon", `pkg:telo/local/napi?path=./${ADDON}&os=plan9&arch=${host.arch}#echo`],
    ["a dylib, which only the Rust kernel opens", `pkg:telo/local/dylib?path=./native/libecho.so&os=${host.os}&arch=${host.arch}&abi=telo-2`],
  ])("falls through as env-missing for %s", async (_label, purl) => {
    const moduleDir = path.join(dir, "checkout");
    await expect(
      new BundleControllerLoader().resolve(purl, pathToFileURL(path.join(moduleDir, "telo.yaml")).href),
    ).rejects.toBeInstanceOf(ControllerEnvMissingError);
  });
});

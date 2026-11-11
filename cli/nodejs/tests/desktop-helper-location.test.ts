import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { helperAssetName, locateHelper } from "../src/desktop/desktop-helper-location.js";

const VERSION = "0.133.0";
const TARGET = "linux-amd64-gnu";
const ASSET = `telo-desktop-host-${VERSION}-${TARGET}`;

let root: string;
let requests: string[];
let bytes: Buffer;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-helper-location-"));
  requests = [];
  bytes = Buffer.from("the helper");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const file = (name: string) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, "x");
  return p;
};

const served =
  (checksum: string = createHash("sha256").update("the helper").digest("hex"), status = 200) =>
  async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    if (status !== 200) return new Response("", { status });
    if (url.endsWith(ASSET)) return new Response(new Uint8Array(bytes));
    if (url.endsWith("checksums.txt")) return new Response(`${checksum}  ${ASSET}\n`);
    return new Response("", { status: 404 });
  };

const download = (fetch = served()) => ({
  env: {},
  version: VERSION,
  target: TARGET,
  cacheRoot: path.join(root, "cache"),
  fetch,
});

describe("locating the helper", () => {
  it("prefers the host value, then the packaged copy, then a source checkout, then the release", async () => {
    const envHelper = file("from-env");
    const packaged = file("packaged");
    const built = path.join(root, "target", "release", "telo-desktop-host");
    let builds = 0;
    const buildInCheckout = async () => {
      builds++;
      fs.mkdirSync(path.dirname(built), { recursive: true });
      fs.writeFileSync(built, "x");
    };
    const all = { ...download(), checkout: { root }, buildInCheckout, platform: "linux" as const };

    expect(await locateHelper({ ...all, env: { TELO_HOST_DESKTOP_HELPER: envHelper }, packagedHelperPath: packaged })).toBe(envHelper);
    expect(await locateHelper({ ...all, packagedHelperPath: packaged })).toBe(packaged);
    expect(builds).toBe(0);
    expect(await locateHelper(all)).toBe(built);
    expect(builds).toBe(1);
    expect(requests).toEqual([]);
    expect(await locateHelper({ ...download(), checkout: null })).toBe(path.join(root, "cache", VERSION, ASSET));
  });

  it("refuses a host value that is not an absolute path to a file", async () => {
    await expect(locateHelper({ env: { TELO_HOST_DESKTOP_HELPER: "helper" } })).rejects.toMatchObject({
      code: "ERR_DESKTOP_HOST_UNAVAILABLE",
      message: expect.stringContaining("TELO_HOST_DESKTOP_HELPER names helper"),
    });
  });

  it("reports a failed build as the helper being unavailable", async () => {
    await expect(
      locateHelper({ env: {}, checkout: { root }, buildInCheckout: async () => Promise.reject(new Error("linker not found")) }),
    ).rejects.toMatchObject({
      code: "ERR_DESKTOP_HOST_UNAVAILABLE",
      message: "cannot start the desktop host: building telo-desktop-host with cargo failed: linker not found",
    });
  });
});

describe("downloading the helper", () => {
  it("names the asset after the release, verifies it and serves it from the cache afterwards", async () => {
    expect(helperAssetName(VERSION, "windows-arm64")).toBe(`telo-desktop-host-${VERSION}-windows-arm64.exe`);
    const first = await locateHelper(download());
    expect(fs.readFileSync(first, "utf8")).toBe("the helper");
    expect(requests).toHaveLength(2);
    expect(await locateHelper(download())).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it("refuses bytes that do not match checksums.txt and keeps nothing", async () => {
    await expect(locateHelper(download(served("0".repeat(64))))).rejects.toMatchObject({
      code: "ERR_DESKTOP_HOST_UNAVAILABLE",
      message: expect.stringContaining("checksum mismatch"),
    });
    expect(fs.existsSync(path.join(root, "cache", VERSION, ASSET))).toBe(false);
  });

  it("says which download failed and how", async () => {
    await expect(locateHelper(download(served(undefined, 503)))).rejects.toMatchObject({
      message: `cannot start the desktop host: ${ASSET} could not be downloaded (HTTP 503 from github.com)`,
    });
  });
});

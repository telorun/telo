import { makeTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { releaseBinary, ReleaseBinaryError } from "../src/release-binary.js";

const TARGET = "linux-amd64-gnu";
const VERSION = "0.40.0";
const ASSET = `telo-${VERSION}-${TARGET}.tar.gz`;

let cacheRoot: string;
let requests: string[];
let archive: Buffer;

beforeEach(async () => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telo-release-binary-"));
  requests = [];
  archive = Buffer.from(
    await makeTarGz([{ name: `telo-${VERSION}-${TARGET}/telo`, content: Buffer.from("the binary") }]),
  );
});

afterEach(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));

const served = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  const url = String(input);
  requests.push(url);
  if (url.endsWith(ASSET)) return new Response(new Uint8Array(archive));
  if (url.endsWith("checksums.txt")) {
    return new Response(`${createHash("sha256").update(archive).digest("hex")}  ${ASSET}\n`);
  }
  return new Response("", { status: 404 });
};

describe("a release binary", () => {
  it("is downloaded once, verified, and served from the cache afterwards", async () => {
    const first = await releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served });
    expect(fs.readFileSync(first, "utf8")).toBe("the binary");
    // Windows has no executable bit: a file runs by its extension there.
    if (process.platform !== "win32") expect(fs.statSync(first).mode & 0o111).not.toBe(0);
    expect(requests).toHaveLength(2);

    const second = await releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served });
    expect(second).toBe(first);
    expect(requests).toHaveLength(2);
  });

  it("is fetched once when two starts ask for it together, and both get the finished file", async () => {
    const [one, two] = await Promise.all([
      releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served }),
      releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served }),
    ]);

    expect(two).toBe(one);
    expect(requests).toHaveLength(2);
    expect(fs.readFileSync(one, "utf8")).toBe("the binary");
    expect(fs.readdirSync(path.dirname(one)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("is refused from the cache once its bytes are no longer the ones downloaded", async () => {
    const file = await releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served });
    fs.writeFileSync(file, "something else");

    const refusal = await releaseBinary(TARGET, VERSION, { cacheRoot, fetch: served }).catch((e) => e);
    expect(refusal).toBeInstanceOf(ReleaseBinaryError);
    expect(refusal.failure).toBe("cache-corrupt");
    expect(refusal.message).toContain(file);
  });

  it("says the host could not be reached when the request itself fails", async () => {
    const refusal = await releaseBinary(TARGET, VERSION, {
      cacheRoot,
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND github.com") });
      },
    }).catch((e) => e);
    expect(refusal.failure).toBe("unreachable");
    expect(refusal.message).toMatch(/could not reach .*ENOTFOUND/);
  });

  it("is refused where there is nowhere to keep it", async () => {
    const refusal = await releaseBinary(TARGET, VERSION, { cacheRoot: null, fetch: served }).catch((e) => e);
    expect(refusal.failure).toBe("no-cache-directory");
  });

  it("names the published platforms for one that has no binary", async () => {
    const refusal = await releaseBinary("plan9-amd64", VERSION, { cacheRoot, fetch: served }).catch((e) => e);
    expect(refusal.failure).toBe("unpublished-platform");
    expect(requests).toHaveLength(0);
  });
});

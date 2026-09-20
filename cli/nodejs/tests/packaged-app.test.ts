import * as fs from "fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAYLOAD_INDEX, packPayload } from "../src/package/app-payload.js";
import { encodeTrailer, payloadDigest } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";
import { loadPackagedApp } from "../src/package/run-packaged-app.js";

/**
 * What a packaged application does to the machine it runs on: it unpacks once,
 * holds the tree it is using, and reclaims its own older ones.
 *
 * The sweep is the half worth pinning down. Reclaiming is safe BECAUSE a tree
 * comes back out of the binary that owns it — but only for a tree nothing is
 * using, so "held by a live process" has to mean exactly that.
 */

let dir: string;
let appDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-packaged-"));
  appDir = path.join(dir, "apps-root");
});

afterEach(async () => {
  delete process.env.TELO_CACHE_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

const INDEX = {
  format: 1,
  app: { name: "Orders", version: "1.0.0" },
  entry: "app/telo.yaml",
  platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
  telo: "9.9.9",
  analysisKey: "a".repeat(64),
  modules: [],
};

/** A carrier with a payload appended — the shape `telo package` writes for every
 *  platform but darwin. */
async function carrier(body = "kind: Telo.Application\n"): Promise<{ file: string; digest: string }> {
  const payload = await packPayload([
    { name: PAYLOAD_INDEX, content: JSON.stringify(INDEX) },
    { name: "app/telo.yaml", content: body },
    { name: "cache/manifests/keep.yaml", content: "kind: Telo.Library\n" },
  ]);
  const file = path.join(dir, `carrier-${payloadDigest(payload).slice(0, 8)}`);
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
  return { file, digest: payloadDigest(payload) };
}

const env = () => ({ TELO_APP_DIR: appDir });

/** The unpacked application, or a failure naming what the carrier turned out to
 *  be instead. */
async function app(file: string) {
  const carried = await loadPackagedApp(file, env());
  if (carried.kind !== "app") throw new Error(`expected an application, got ${carried.kind}`);
  return carried.app;
}

describe("a packaged binary", () => {
  it("reports nothing for a carrier with no payload", async () => {
    const plain = path.join(dir, "plain");
    await fs.writeFile(plain, Buffer.alloc(4096, 2));
    expect((await loadPackagedApp(plain, env())).kind).toBe("none");
  });

  it("unpacks once, keyed by the payload's digest, and reuses the tree", async () => {
    const { file, digest } = await carrier();
    const first = await app(file);
    expect(first.dir).toBe(path.join(appDir, "apps", `Orders-${digest.slice(0, 16)}`));
    expect(existsSync(first.entry)).toBe(true);
    // The payload IS the cache, and it is handed to the run as a value rather
    // than written into the environment.
    expect(first.cacheDir).toBe(path.join(first.dir, "cache"));
    expect(process.env.TELO_CACHE_DIR).toBeUndefined();

    const marker = path.join(first.dir, ".telo-app-ready");
    const stamped = (await fs.stat(marker)).mtimeMs;
    const second = await app(file);
    expect(second.dir).toBe(first.dir);
    expect((await fs.stat(marker)).mtimeMs).toBe(stamped);
  });

  it("reclaims its own older trees, and keeps one a live process holds", async () => {
    const { file } = await carrier();
    const root = path.join(appDir, "apps");
    mkdirSync(root, { recursive: true });

    // An older build of the same app that nothing is running.
    const idle = path.join(root, "Orders-0000000000000000");
    mkdirSync(idle, { recursive: true });
    writeFileSync(path.join(idle, ".telo-app-ready"), "x");

    // An older build still serving: its hold names a live pid — this process.
    const held = path.join(root, "Orders-1111111111111111");
    mkdirSync(path.join(held, "live"), { recursive: true });
    writeFileSync(path.join(held, "live", String(process.pid)), "");

    // Another application entirely, which is never this one's to reclaim.
    const other = path.join(root, "Invoices-2222222222222222");
    mkdirSync(other, { recursive: true });

    await loadPackagedApp(file, env());

    expect(existsSync(idle)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("sweeps a hold left by a process that is gone", async () => {
    const { file } = await carrier();
    const root = path.join(appDir, "apps");
    const stale = path.join(root, "Orders-3333333333333333");
    mkdirSync(path.join(stale, "live"), { recursive: true });
    // A pid no process can have — the sweep answers the question rather than
    // guessing at an age.
    writeFileSync(path.join(stale, "live", "2147483646"), "");

    await loadPackagedApp(file, env());
    expect(existsSync(stale)).toBe(false);
  });

  it("gives two different payloads two trees", async () => {
    const one = await carrier("kind: Telo.Application\n# one\n");
    const two = await carrier("kind: Telo.Application\n# two\n");
    const first = await app(one.file);
    const second = await app(two.file);
    expect(first.dir).not.toBe(second.dir);
    // The second start reclaimed the first, which nothing was holding.
    expect(existsSync(second.dir)).toBe(true);
  });
});

describe("the payload a packaging produces", () => {
  it("is a pure function of the closure, so a rebuild reuses the unpacked tree", async () => {
    // An application with no imports: the assembly still walks the graph, warms
    // the analysis verdict and frames the tar, which is everything that could
    // record when it ran. A build timestamp in the index is the one field that
    // quietly undoes this, and it is what this caught.
    const app = path.join(dir, "tiny");
    mkdirSync(app, { recursive: true });
    writeFileSync(
      path.join(app, "telo.yaml"),
      "kind: Telo.Application\nmetadata:\n  name: Tiny\n  version: 1.0.0\n",
    );
    const report = (): void => {};
    const platform = { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" };
    const first = await buildAppPayload({ manifestPath: app, platform, report });
    const second = await buildAppPayload({ manifestPath: app, platform, report });
    expect(payloadDigest(second.payload)).toBe(payloadDigest(first.payload));
  });
});

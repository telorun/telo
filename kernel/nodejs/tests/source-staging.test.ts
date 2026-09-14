import { readModuleSources, type ModuleSource } from "@telorun/analyzer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NOOP_LOGGER, type Logger } from "@telorun/sdk";

import {
  ArchiveContentError,
  ArchiveFetchError,
  createArchiveReader,
  ensureStagedEntry,
} from "../src/bundle/source-staging.js";
import { makeTarGz } from "../src/bundle/tar.js";

const LIB = Buffer.from("\x7fELF library bytes");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

let server: http.Server;
let base: string;
const requests: string[] = [];
let releaseSlow: () => void = () => {};

beforeAll(async () => {
  const archive = await makeTarGz([{ name: "package/lib/libx.so.1", content: LIB }]);
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/lib-1.0.0.tgz") {
      res.writeHead(200).end(archive);
      return;
    }
    if (req.url === "/slow-1.0.0.tgz") {
      new Promise<void>((resolve) => (releaseSlow = resolve)).then(() => res.writeHead(200).end(archive));
      return;
    }
    if (req.url === "/redirect-1.0.0.tgz") {
      res.writeHead(302, { location: "http://example.test/lib-1.0.0.tgz" }).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-staging-test-"));
  requests.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sourceFor(options: { url?: string; sha256?: string; pinned?: boolean } = {}): ModuleSource {
  const pin = options.pinned === false ? {} : { sha256: options.sha256 ?? sha(LIB), executable: false };
  const read = readModuleSources({
    sources: {
      lib: {
        version: "1.0.0",
        url: options.url ?? `${base}/lib-{version}.tgz`,
        archive: "tar.gz",
        notices: ["./LICENSE"],
        entries: {
          "./native/libx.so.1": { upstream: "x", member: "package/lib/libx.so.1", ...pin },
          "./native/libx.so": { target: "libx.so.1" },
        },
      },
    },
  });
  expect(read.problems).toEqual([]);
  return read.sources[0]!;
}

const entry = (source: ModuleSource, entryPath: string) =>
  source.entries.find((candidate) => candidate.path === entryPath)!;

describe("ensureStagedEntry", () => {
  it("fetches a missing file, verifies it against its pin and writes it", async () => {
    const source = sourceFor();
    const state = await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"));
    expect(state).toEqual({ state: "match" });
    expect(fs.readFileSync(path.join(dir, "native/libx.so.1"))).toEqual(LIB);
    expect(requests).toEqual(["/lib-1.0.0.tgz"]);
  });

  it("does not fetch a file that already matches its pin", async () => {
    const source = sourceFor();
    fs.mkdirSync(path.join(dir, "native"));
    fs.writeFileSync(path.join(dir, "native/libx.so.1"), LIB);
    expect(await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"))).toEqual({ state: "match" });
    expect(requests).toEqual([]);
  });

  it("fetches a stale file again", async () => {
    const source = sourceFor();
    fs.mkdirSync(path.join(dir, "native"));
    fs.writeFileSync(path.join(dir, "native/libx.so.1"), "an older release");
    expect(await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"))).toEqual({ state: "match" });
    expect(fs.readFileSync(path.join(dir, "native/libx.so.1"))).toEqual(LIB);
  });

  it("stages the file a link leads to, then the link", async () => {
    const source = sourceFor();
    expect(await ensureStagedEntry(dir, source, entry(source, "native/libx.so"))).toEqual({ state: "match" });
    expect(fs.readlinkSync(path.join(dir, "native/libx.so"))).toBe("libx.so.1");
    expect(fs.readFileSync(path.join(dir, "native/libx.so"))).toEqual(LIB);
  });

  it("refuses bytes that do not match the pin, and writes nothing", async () => {
    const source = sourceFor({ sha256: sha("something else") });
    const rejection = ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"));
    await expect(rejection).rejects.toBeInstanceOf(ArchiveContentError);
    await expect(rejection).rejects.toThrow(`member 'package/lib/libx.so.1' hashes to sha256 ${sha(LIB)}`);
    expect(fs.existsSync(path.join(dir, "native/libx.so.1"))).toBe(false);
  });

  it("returns an unpinned entry without fetching it", async () => {
    const source = sourceFor({ pinned: false });
    expect(await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"))).toEqual({ state: "unpinned" });
    expect(requests).toEqual([]);
  });

  it("reports an upstream it could not reach as a fetch failure naming the URL", async () => {
    const source = sourceFor({ url: `${base}/gone-{version}.tgz` });
    const rejection = ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"));
    await expect(rejection).rejects.toBeInstanceOf(ArchiveFetchError);
    await expect(rejection).rejects.toThrow(`${base}/gone-1.0.0.tgz answered 404`);
  });

  it.each([
    [
      "a redirect to a location a source could not name",
      () => ({ source: sourceFor({ url: `${base}/redirect-{version}.tgz` }) }),
      ArchiveFetchError,
      "was redirected to http://example.test/",
    ],
    [
      "a response past the size limit",
      () => ({ source: sourceFor(), archives: createArchiveReader({ maxBytes: 16 }) }),
      ArchiveFetchError,
      "larger than the 16-byte limit",
    ],
    [
      "an archive that decompresses past the limit",
      () => ({ source: sourceFor(), archives: createArchiveReader({ maxExtractedBytes: 16 }) }),
      ArchiveContentError,
      "decompresses to more than the 16-byte limit",
    ],
  ])("refuses %s, writing nothing", async (_label, setup, kind, message) => {
    const { source, archives } = setup();
    const rejection = ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"), { archives });
    await expect(rejection).rejects.toBeInstanceOf(kind);
    await expect(rejection).rejects.toThrow(message);
    expect(fs.existsSync(path.join(dir, "native/libx.so.1"))).toBe(false);
  });

  it("follows TELO_EGRESS at the first hop", async () => {
    process.env.TELO_EGRESS = "public-only";
    try {
      const source = sourceFor();
      const rejection = ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"));
      await expect(rejection).rejects.toBeInstanceOf(ArchiveFetchError);
      await expect(rejection).rejects.toThrow(`the archive request ${base}/lib-1.0.0.tgz was refused`);
      expect(requests).toEqual([]);
    } finally {
      delete process.env.TELO_EGRESS;
    }
  });

  it("reports a failure that is neither a fetch nor the archive's content as neither", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-staging-outside-"));
    fs.symlinkSync(outside, path.join(dir, "native"));
    try {
      const source = sourceFor();
      const rejection = ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"));
      await expect(rejection).rejects.toThrow("'native' is a symbolic link on disk");
      await expect(rejection).rejects.not.toBeInstanceOf(ArchiveContentError);
      await expect(rejection).rejects.not.toBeInstanceOf(ArchiveFetchError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("logs one line naming the entry and URL when it fetches, and none when the file matches", async () => {
    const lines: string[] = [];
    const log = { ...NOOP_LOGGER, info: (message: string) => void lines.push(message) } as Logger;
    const source = sourceFor();
    await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"), { log });
    await ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"), { log });
    expect(lines).toEqual([`staging 'native/libx.so.1' of the module at ${dir} from ${base}/lib-1.0.0.tgz`]);
  });

  it("stages entries from different archives side by side", async () => {
    const slow = sourceFor({ url: `${base}/slow-{version}.tgz` });
    const fast = readModuleSources({
      sources: {
        other: {
          version: "1.0.0",
          url: `${base}/lib-{version}.tgz`,
          archive: "tar.gz",
          notices: ["./LICENSE"],
          entries: { "./other/libx.so.1": { upstream: "x", member: "package/lib/libx.so.1", sha256: sha(LIB), executable: false } },
        },
      },
    }).sources[0]!;
    const pending = ensureStagedEntry(dir, slow, entry(slow, "native/libx.so.1"));
    await expect.poll(() => requests).toContain("/slow-1.0.0.tgz");
    expect(await ensureStagedEntry(dir, fast, entry(fast, "other/libx.so.1"))).toEqual({ state: "match" });
    releaseSlow();
    expect(await pending).toEqual({ state: "match" });
  });

  it("fetches once when several callers stage one file at the same time", async () => {
    const source = sourceFor();
    const states = await Promise.all(
      [1, 2, 3].map(() => ensureStagedEntry(dir, source, entry(source, "native/libx.so.1"))),
    );
    expect(states).toEqual([{ state: "match" }, { state: "match" }, { state: "match" }]);
    expect(requests).toEqual(["/lib-1.0.0.tgz"]);
  });
});

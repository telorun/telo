import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveModuleFileUri, type ModuleFileLookup } from "../src/module-file-resolution.js";
import {
  MAX_REMOTE_FILE_BYTES,
  RemoteModuleFiles,
  pinnedFilesDirectory,
  remoteManifestUrl,
  remoteModuleScratchDirectory,
} from "../src/remote-module-files.js";

let server: http.Server;
let origin: string;
const requests: string[] = [];
let body = "first";
let bigBody: Buffer | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/app/assets/logo.svg") res.writeHead(200).end(body);
    else if (req.url === "/app/assets/big.bin") res.writeHead(200).end(bigBody);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir: string;
let files: RemoteModuleFiles;
let manifestUrl: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-remote-files-test-"));
  files = new RemoteModuleFiles();
  manifestUrl = `${origin}/app/telo.yaml`;
  requests.length = 0;
  body = "first";
  bigBody = undefined;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lookup = (): ModuleFileLookup => ({
  remoteModuleFiles: files,
  getModuleArtifact: () => undefined,
  getDeclaringModule: () => undefined,
  ensureStagedEntry: () => {
    throw new Error("unexpected");
  },
});

describe("files of a module read over plain HTTP", () => {
  it("fetches a claimed file from beside the manifest into the module directory", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    const uri = await resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup());
    expect(fileURLToPath(uri)).toBe(path.join(dir, "assets", "logo.svg"));
    expect(fs.readFileSync(fileURLToPath(uri), "utf8")).toBe("first");
    expect(requests).toEqual(["/app/assets/logo.svg"]);
  });

  it("fetches a file once per run", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await Promise.all([
      resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup()),
      resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup()),
    ]);
    expect(requests).toHaveLength(1);
  });

  it("fetches again when the manifest was fetched, and keeps the cached file when it was not", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    const uri = await resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup());
    body = "second";
    const fresh = new RemoteModuleFiles();
    fresh.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await resolveModuleFileUri("assets/logo.svg", manifestUrl, { ...lookup(), remoteModuleFiles: fresh });
    expect(fs.readFileSync(fileURLToPath(uri), "utf8")).toBe("second");

    const cached = new RemoteModuleFiles();
    cached.register(manifestUrl, { manifestUrl, directory: dir, reuse: true });
    requests.length = 0;
    body = "third";
    await resolveModuleFileUri("assets/logo.svg", manifestUrl, { ...lookup(), remoteModuleFiles: cached });
    expect(requests).toEqual([]);
    expect(fs.readFileSync(fileURLToPath(uri), "utf8")).toBe("second");
  });

  it("refuses a file the origin does not serve, naming the URL", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await expect(resolveModuleFileUri("missing.svg", manifestUrl, lookup())).rejects.toThrow(
      /app\/missing\.svg returned 404/,
    );
  });

  it("refuses a path that leaves the module", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await expect(resolveModuleFileUri("../outside.txt", manifestUrl, lookup())).rejects.toThrow(
      /leaves the module/,
    );
  });

  it("refuses a path whose URL leaves the module though the local path does not", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await expect(resolveModuleFileUri("%2e%2e/%2e%2e/x", manifestUrl, lookup())).rejects.toThrow(
      /leaves the module/,
    );
    expect(requests).toEqual([]);
  });

  it("refuses to write through a link that leads out of the module directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-remote-outside-"));
    try {
      fs.symlinkSync(outside, path.join(dir, "assets"));
      files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
      await expect(resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup())).rejects.toThrow(
        /leaves the module/,
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves no partial file behind when the origin fails", async () => {
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await expect(resolveModuleFileUri("assets/missing.svg", manifestUrl, lookup())).rejects.toThrow();
    const leftovers = fs.existsSync(path.join(dir, "assets")) ? fs.readdirSync(path.join(dir, "assets")) : [];
    expect(leftovers).toEqual([]);
  });

  it("refuses a file larger than the bound, and removes what it had written", async () => {
    bigBody = Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1);
    files.register(manifestUrl, { manifestUrl, directory: dir, reuse: false });
    await expect(resolveModuleFileUri("assets/big.bin", manifestUrl, lookup())).rejects.toThrow(
      /larger than the \d+ bytes/,
    );
    expect(fs.readdirSync(path.join(dir, "assets"))).toEqual([]);
  }, 30_000);

  it("keeps a pinned module's files under its pin, so a re-pin never finds another's", () => {
    const a = pinnedFilesDirectory("/cache/m", "https://h/m/telo.yaml#sha256-AAA");
    const b = pinnedFilesDirectory("/cache/m", "https://h/m/telo.yaml#sha256-BBB");
    expect(a).not.toBe(b);
    expect(pinnedFilesDirectory("/cache/m", "https://h/m/telo.yaml")).toBe("/cache/m");
  });

  it("refuses a scratch directory another user could have prepared", async () => {
    if (typeof process.getuid !== "function") return;
    const root = path.join(dir, "shared");
    fs.mkdirSync(root, { mode: 0o777 });
    fs.chmodSync(root, 0o777);
    files.register(manifestUrl, { manifestUrl, directory: path.join(root, "m"), reuse: false, privateRoot: root });
    await expect(resolveModuleFileUri("assets/logo.svg", manifestUrl, lookup())).rejects.toThrow(
      /owned by this user/,
    );
    expect(requests).toEqual([]);
  });

  it("puts the scratch directory in one private to the user", () => {
    const scratch = remoteModuleScratchDirectory(manifestUrl);
    expect(scratch.directory.startsWith(scratch.root + path.sep)).toBe(true);
    if (typeof process.getuid === "function") expect(scratch.root).toContain(String(process.getuid()));
  });

  it("derives the manifest URL a ref is read from, as the HTTP source reads it", () => {
    expect(remoteManifestUrl("https://h/app/telo.yaml#sha256-abc")).toBe("https://h/app/telo.yaml");
    expect(remoteManifestUrl("https://h/app")).toBe("https://h/app/telo.yaml");
    expect(remoteManifestUrl("oci://h/app")).toBeUndefined();
  });
});

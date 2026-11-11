import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpSource } from "../src/sources/http-source.js";

let server: http.Server;
let manifest: string;
const seen: { method?: string; encoding?: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, encoding: req.headers["accept-encoding"] as string | undefined });
    // Ignores `Range`, as a simple static server does.
    if (req.url === "/app/logo.png") res.writeHead(200).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    else if (req.url === "/app/broken.txt") res.writeHead(500).end();
    else if (req.url === "/app/nohead.png" && req.method === "HEAD") res.writeHead(405).end();
    else if (req.url === "/app/nohead.png") res.writeHead(200).end(Buffer.from([1]));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  manifest = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app/telo.yaml`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("HttpSource module files", () => {
  const source = new HttpSource();

  it("answers a served file as a file and a missing one as nothing", async () => {
    expect(await source.entryAt(manifest, "./logo.png")).toBe("file");
    expect(await source.entryAt(manifest, "./nope.png")).toBeUndefined();
  });

  it("asks for the existence with HEAD and the head uncompressed", async () => {
    seen.length = 0;
    await source.entryAt(manifest, "./logo.png");
    await source.readHead(manifest, "./logo.png", 4);
    expect(seen.map((r) => r.method)).toEqual(["HEAD", "GET"]);
    expect(seen[1].encoding).toMatch(/^identity/);
  });

  it("reads only the leading bytes", async () => {
    expect(Array.from((await source.readHead(manifest, "./logo.png", 4))!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await source.readHead(manifest, "./nope.png", 4)).toBeUndefined();
  });

  it("refuses a server error rather than reporting the file missing", async () => {
    await expect(source.entryAt(manifest, "./broken.txt")).rejects.toThrow(/500/);
  });

  it("asks for the first byte when a server refuses HEAD", async () => {
    expect(await source.entryAt(manifest, "./nohead.png")).toBe("file");
  });

  it("locates a file beside the manifest", () => {
    expect(source.locate(manifest, "./logo.png")).toBe(manifest.replace("telo.yaml", "logo.png"));
  });
});

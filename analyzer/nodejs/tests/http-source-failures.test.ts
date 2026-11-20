import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpSource } from "../src/sources/http-source.js";

let server: http.Server;
let origin: string;
let closedOrigin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/refused/telo.yaml") res.writeHead(503).end("unavailable");
    else res.writeHead(404).end("not here");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  closedOrigin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("HttpSource read failures", () => {
  const source = new HttpSource();

  it("reads any other non-2xx reply as a refusal carrying its status", async () => {
    await expect(source.read(`${origin}/refused`)).rejects.toMatchObject({
      sourceFailure: "refused",
      status: 503,
      message: `the host refused the request for ${origin}/refused/telo.yaml (HTTP 503).`,
    });
  });

  it("reads a request that reached no host as unreachable, keeping the transport's error as the cause", async () => {
    const failure = await source.read(`${closedOrigin}/app`).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      sourceFailure: "unreachable",
      message: `${closedOrigin}/app/telo.yaml cannot be reached: no connection to its host could be made.`,
    });
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });
});

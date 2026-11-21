import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importResolutionDiagnostics } from "../src/import-resolution-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import { HttpSource } from "../src/sources/http-source.js";
import type { ManifestSource } from "../src/types.js";

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

  it("keeps an import of a well-formed URL whose host cannot be reached IMPORT_UNRESOLVED, unreachable", async () => {
    const entry: ManifestSource = {
      supports: (url) => url === "/ws/telo.yaml",
      read: async (url) => ({
        text: `kind: Telo.Application\nmetadata: { name: App }\nimports: { Lib: "${closedOrigin}/lib" }\n`,
        source: url,
      }),
      resolveRelative: (base, relative) => relative,
    };
    const graph = await new Loader([entry, new HttpSource()]).loadGraph("/ws/telo.yaml", {
      desugarImports: true,
    });
    const [diagnostic] = importResolutionDiagnostics(graph);
    expect(diagnostic).toMatchObject({
      code: "IMPORT_UNRESOLVED",
      data: { sourceFailure: "unreachable", path: "imports.Lib" },
    });
  });
});

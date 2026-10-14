import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerEngine } from "../src/engine-controller.js";

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A fake Engine API endpoint — a unix socket, or loopback TCP on Windows,
 *  where a listen path is a named pipe: answers each request with `answer`
 *  and records what it was sent. */
async function endpoint(
  answer: (req: Seen, res: ServerResponse) => void,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer(async (req: IncomingMessage, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const entry: Seen = {
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      ...(text ? { body: JSON.parse(text) } : {}),
    };
    seen.push(entry);
    answer(entry, res);
  });
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, seen };
  }
  const socket = path.join(mkdtempSync(path.join(tmpdir(), "telo-docker-")), "engine.sock");
  await new Promise<void>((resolve) => server!.listen(socket, resolve));
  return { url: `unix://${socket}`, seen };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("Docker.Engine", () => {
  it("creates with exactly the allowed keys and one loopback binding per port", async () => {
    const { url, seen } = await endpoint((_req, res) => json(res, 201, { Id: "abc" }));
    const engine = new DockerEngine({ metadata: { name: "docker" }, endpoint: url, token: "s3cret" });
    const id = await engine.create({
      image: "postgres:18",
      command: ["postgres", "-c", "fsync=off"],
      env: { POSTGRES_PASSWORD: "pw" },
      user: "999:999",
      ports: [5432, 8080],
      labels: { "run.telo.container.expires": "1700000000" },
    });
    expect(id).toBe("abc");
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/v1.41/containers/create",
        authorization: "Bearer s3cret",
        body: {
          Image: "postgres:18",
          Cmd: ["postgres", "-c", "fsync=off"],
          Env: ["POSTGRES_PASSWORD=pw"],
          User: "999:999",
          ExposedPorts: { "5432/tcp": {}, "8080/tcp": {} },
          Labels: { "run.telo.container.expires": "1700000000" },
          HostConfig: {
            PortBindings: {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
              "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
            },
          },
        },
      },
    ]);
  });

  it("reads a port's address from its binding, never from the container's network address", async () => {
    const { url } = await endpoint((_req, res) =>
      json(res, 200, {
        State: { Running: true, ExitCode: 0 },
        NetworkSettings: {
          IPAddress: "172.17.0.9",
          Networks: { bridge: { IPAddress: "172.17.0.9" } },
          Ports: { "5432/tcp": [{ HostIp: "10.42.0.7", HostPort: "5432" }] },
        },
      }),
    );
    const engine = new DockerEngine({ metadata: { name: "docker" }, endpoint: url });
    const state = await engine.inspect("abc");
    expect(state.running).toBe(true);
    expect([...state.bindings]).toEqual([[5432, { host: "10.42.0.7", port: 5432 }]]);
  });

  it("pulls an untagged image as latest, and fails on an error in the progress stream", async () => {
    const { url, seen } = await endpoint((_req, res) => {
      res.writeHead(200);
      res.end('{"status":"Pulling"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n');
    });
    const engine = new DockerEngine({ metadata: { name: "docker" }, endpoint: url });
    await expect(engine.pullImage("library/busybox")).rejects.toThrow(
      "pulling library/busybox failed: manifest unknown",
    );
    expect(seen[0].url).toBe("/v1.41/images/create?fromImage=library%2Fbusybox&tag=latest");
  });

  it("reads the log stream's framing as text", async () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const { url, seen } = await endpoint((_req, res) => {
      res.writeHead(200);
      const bytes = Buffer.concat([frame(1, "out ✓\n"), frame(2, "err\n")]);
      // Split inside a header and inside a multi-byte character.
      res.write(bytes.subarray(0, 3));
      res.write(bytes.subarray(3, 13));
      res.end(bytes.subarray(13));
    });
    const engine = new DockerEngine({ metadata: { name: "docker" }, endpoint: url });
    let text = "";
    for await (const chunk of engine.logs("abc", { follow: true })) text += chunk;
    expect(text).toBe("out ✓\nerr\n");
    expect(seen[0].url).toBe("/v1.41/containers/abc/logs?follow=true&stdout=true&stderr=true");
  });

  it("treats removing a container that is gone as done", async () => {
    const { url, seen } = await endpoint((_req, res) => json(res, 404, { message: "No such container" }));
    const engine = new DockerEngine({ metadata: { name: "docker" }, endpoint: url });
    await engine.remove("abc");
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/v1.41/containers/abc?force=true&v=true" });
  });

  it("sends every request beneath an HTTP endpoint's path prefix", async () => {
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("OK");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const engine = new DockerEngine({
      metadata: { name: "docker" },
      endpoint: `http://127.0.0.1:${port}/v1/sessions/s1/engine/`,
    });
    await engine.ping();
    expect(seen).toEqual(["/v1/sessions/s1/engine/v1.41/_ping"]);
  });
});

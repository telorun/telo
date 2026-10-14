import { Readable } from "node:stream";

import { SessionContainerNotFound } from "@telorun/runner-core";
import { describe, expect, it } from "vitest";

import {
  createDockerSessionContainerEngine,
  type EngineCreateOptions,
  type EngineDockerClient,
  type EngineDockerContainer,
  type InspectedContainer,
} from "./session-container-engine.js";

const NETWORK = "telo_default";

function frame(stream: number, text: string): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([header, Buffer.from(text)]);
}

function daemonError(statusCode: number): Error {
  return Object.assign(new Error(`daemon answered ${statusCode}`), { statusCode });
}

function fakeDocker(container: Partial<EngineDockerContainer>, created: EngineCreateOptions[] = []) {
  const client: EngineDockerClient = {
    ping: async () => "OK",
    getImage: () => ({ inspect: async () => ({}) }),
    pull: async () => Readable.from([]),
    modem: { followProgress: (stream, done) => done(null, []) },
    async createContainer(options) {
      created.push(options);
      return { id: "c1" };
    },
    getContainer: () => container as EngineDockerContainer,
  };
  return client;
}

describe("the docker session container engine", () => {
  it("creates a container on the child network, labelled, publishing nothing", async () => {
    const created: EngineCreateOptions[] = [];
    const engine = createDockerSessionContainerEngine({
      docker: fakeDocker({}, created),
      childNetwork: NETWORK,
    });
    await engine.create("abc", {
      image: "pgvector/pgvector:pg18",
      env: ["POSTGRES_PASSWORD=postgres"],
      user: "999:999",
      ports: [5432],
      labels: { "run.telo.session": "abc" },
    });
    expect(created).toEqual([
      {
        Image: "pgvector/pgvector:pg18",
        Env: ["POSTGRES_PASSWORD=postgres"],
        User: "999:999",
        ExposedPorts: { "5432/tcp": {} },
        Labels: { "run.telo.session": "abc" },
        HostConfig: { NetworkMode: NETWORK },
      },
    ]);
  });

  it("reports the container's address on the child network", async () => {
    const inspected: InspectedContainer = {
      State: { Running: true, ExitCode: 0, Status: "running" },
      NetworkSettings: {
        Networks: { bridge: { IPAddress: "172.17.0.9" }, [NETWORK]: { IPAddress: "172.20.0.4" } },
      },
    };
    const engine = createDockerSessionContainerEngine({
      docker: fakeDocker({ inspect: async () => inspected }),
      childNetwork: NETWORK,
    });
    expect(await engine.inspect("abc", "c1")).toEqual({
      running: true,
      exitCode: null,
      address: "172.20.0.4",
    });
  });

  it("reads the daemon's multiplexed log stream back into chunks", async () => {
    const both = Buffer.concat([frame(1, "ready\n"), frame(2, "warn")]);
    // Split inside the second header, as a socket may deliver it.
    const stream = Readable.from([both.subarray(0, 17), both.subarray(17)]);
    const engine = createDockerSessionContainerEngine({
      docker: fakeDocker({ logs: (async () => stream) as EngineDockerContainer["logs"] }),
      childNetwork: NETWORK,
    });
    const chunks = [];
    for await (const chunk of await engine.logs("abc", "c1", { follow: true }, new AbortController().signal)) {
      chunks.push({ stream: chunk.stream, text: chunk.data.toString() });
    }
    expect(chunks).toEqual([
      { stream: "stdout", text: "ready\n" },
      { stream: "stderr", text: "warn" },
    ]);
  });

  it("answers a container the daemon does not know as gone", async () => {
    const engine = createDockerSessionContainerEngine({
      docker: fakeDocker({
        inspect: async () => {
          throw daemonError(404);
        },
      }),
      childNetwork: NETWORK,
    });
    await expect(engine.inspect("abc", "c1")).rejects.toBeInstanceOf(SessionContainerNotFound);
  });

  it("treats removing a container already gone as done", async () => {
    const engine = createDockerSessionContainerEngine({
      docker: fakeDocker({
        remove: async () => {
          throw daemonError(404);
        },
      }),
      childNetwork: NETWORK,
    });
    await expect(engine.remove("abc", "c1")).resolves.toBeUndefined();
  });
});

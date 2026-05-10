import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Readable } from "node:stream";

import type { DockerClient } from "./docker/client.js";
import type {
  CreateContainerOpts,
  SessionDockerClient,
  SessionDockerContainer,
} from "./docker/run-session.js";
import type { RunnerConfig } from "./config.js";

export interface FakeDockerBehavior {
  ping?: () => Promise<unknown>;
  inspectVolume?: (name: string) => Promise<unknown>;
  inspectNetwork?: (name: string) => Promise<unknown>;
  inspectImage?: (name: string) => Promise<unknown>;
  pull?: (image: string) => Promise<NodeJS.ReadableStream>;
  createContainer?: (opts: CreateContainerOpts) => Promise<SessionDockerContainer>;
  getContainer?: (name: string) => SessionDockerContainer;
}

export interface FakeDocker extends SessionDockerClient {
  _lastCreateOpts: CreateContainerOpts | null;
  _containers: Map<string, FakeContainer>;
}

// Tests use FakeDocker wherever a DockerClient is required. Dockerode's real
// type has many more methods than we exercise; cast is safe because server.ts
// only reaches for ping / getVolume / getNetwork / getImage / createContainer /
// pull / modem, all of which FakeDocker implements.
export type FakeDockerAsClient = FakeDocker & DockerClient;

export interface FakeContainer extends SessionDockerContainer {
  /** Pushes bytes onto the PTY readable side (simulates container output). */
  emitBytes(chunk: string | Buffer): void;
  /** Drains all bytes the runner has written to the PTY writable side
   *  (simulates capturing what the user typed into the WS). */
  drainPtyInput(): Buffer;
  /** Most recent resize call, if any. */
  lastResize: { h: number; w: number } | null;
  exit(code: number, opts?: { userSignal?: boolean; error?: string }): void;
}

export function makeFakeDocker(behavior: FakeDockerBehavior = {}): FakeDocker {
  const ping = behavior.ping ?? (async () => Buffer.from("OK"));
  const inspectVolume = behavior.inspectVolume ?? (async () => ({ Name: "ok" }));
  const inspectNetwork = behavior.inspectNetwork ?? (async () => ({ Name: "ok" }));
  const inspectImage = behavior.inspectImage ?? (async () => ({ Id: "sha256:ok" }));
  const pull =
    behavior.pull ??
    (async () => {
      // Completed-immediately pull progress stream.
      return Readable.from([]);
    });

  const containers = new Map<string, FakeContainer>();

  const client = {
    _lastCreateOpts: null as CreateContainerOpts | null,
    _containers: containers,
    ping,
    getVolume: (name: string) => ({ inspect: () => inspectVolume(name) }),
    getNetwork: (name: string) => ({ inspect: () => inspectNetwork(name) }),
    getImage: (name: string) => ({ inspect: () => inspectImage(name) }),
    pull,
    modem: {
      followProgress: (
        stream: NodeJS.ReadableStream,
        onFinished: (err: Error | null, output: unknown[]) => void,
      ) => {
        stream.on("end", () => onFinished(null, []));
        stream.on("error", (err: Error) => onFinished(err, []));
        // Readable.from(iterable) ends after the iterable drains.
        stream.resume?.();
      },
    },
    async createContainer(opts: CreateContainerOpts): Promise<SessionDockerContainer> {
      client._lastCreateOpts = opts;
      if (behavior.createContainer) return behavior.createContainer(opts);
      // The hijacked attach yields a true duplex: the runner reads PTY
      // output from one side and writes user keystrokes into the other.
      // We simulate this with two PassThroughs glued together — `outbound`
      // carries bytes from the (fake) container to the runner; `inbound`
      // captures whatever the runner writes (user input).
      const outbound = new PassThrough();
      const inbound = new PassThrough();
      const ptyDuplex = Duplex.from({ readable: outbound, writable: inbound });
      const exitEmitter = new EventEmitter();
      let exitInfo: { StatusCode: number; Error?: { Message: string } | null } | null = null;
      const waitPromise: Promise<{ StatusCode: number; Error?: { Message: string } | null }> = new Promise((resolve) => {
        exitEmitter.once("exit", (info) => {
          exitInfo = info;
          resolve(info);
        });
      });
      const container: FakeContainer = {
        id: `sha256:${opts.name}`,
        lastResize: null,
        async attach() {
          return ptyDuplex;
        },
        async start() {
          /* spawn time */
        },
        async kill() {
          if (!exitInfo) {
            exitEmitter.emit("exit", { StatusCode: 137 });
          }
        },
        async wait() {
          return waitPromise;
        },
        async remove() {
          containers.delete(opts.name);
        },
        async resize(opts) {
          container.lastResize = { h: opts.h, w: opts.w };
        },
        emitBytes(chunk) {
          outbound.write(chunk);
        },
        drainPtyInput() {
          // PassThrough.read() returns whatever's currently buffered; null
          // when empty. Tests typically call this synchronously after the
          // runner has written into the duplex, so the buffer is hot.
          const buf = inbound.read();
          if (!buf) return Buffer.alloc(0);
          return buf instanceof Buffer ? buf : Buffer.from(String(buf));
        },
        exit(code, opts) {
          if (exitInfo) return;
          const info = { StatusCode: code, Error: opts?.error ? { Message: opts.error } : null };
          exitEmitter.emit("exit", info);
          outbound.end();
        },
      };
      containers.set(opts.name, container);
      return container;
    },
    getContainer: (name: string) => {
      if (behavior.getContainer) return behavior.getContainer(name);
      const c = containers.get(name);
      if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
      return c;
    },
  };
  return client as unknown as FakeDockerAsClient;
}

export function makeRunnerConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    port: 8061,
    bundleRoot: "/tmp/test-bundles",
    bundleVolume: "telo_runner-bundles",
    childNetwork: "telo_default",
    logLevel: "error",
    maxSessions: 8,
    exitTtlMs: 60_000,
    replayBufferBytes: 1_000_000,
    corsOrigins: "*" as const,
    ...overrides,
  };
}

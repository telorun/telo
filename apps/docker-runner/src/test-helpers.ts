import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";

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
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
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
  const attachStreams = new Map<string, PassThrough>();
  const demuxRegistrations = new Map<PassThrough, { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }>();

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
      demuxStream: (
        stream: NodeJS.ReadableStream,
        stdout: NodeJS.WritableStream,
        stderr: NodeJS.WritableStream,
      ) => {
        if (stream instanceof PassThrough) {
          demuxRegistrations.set(stream, { stdout, stderr });
        }
      },
    },
    async createContainer(opts: CreateContainerOpts): Promise<SessionDockerContainer> {
      client._lastCreateOpts = opts;
      if (behavior.createContainer) return behavior.createContainer(opts);
      const attach = new PassThrough();
      attachStreams.set(opts.name, attach);
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
        async attach() {
          return attach;
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
        emitStdout(chunk) {
          const dest = demuxRegistrations.get(attach);
          if (dest) dest.stdout.write(chunk);
        },
        emitStderr(chunk) {
          const dest = demuxRegistrations.get(attach);
          if (dest) dest.stderr.write(chunk);
        },
        exit(code, opts) {
          if (exitInfo) return;
          const info = { StatusCode: code, Error: opts?.error ? { Message: opts.error } : null };
          exitEmitter.emit("exit", info);
          const dest = demuxRegistrations.get(attach);
          if (dest) {
            (dest.stdout as PassThrough).end?.();
            (dest.stderr as PassThrough).end?.();
          }
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

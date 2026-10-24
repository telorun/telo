import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { threadId } from "node:worker_threads";

import { FakeSupervisor } from "@telorun/runner-core/test-support";

import { ROLE_LABEL, SUPERVISOR_LISTEN_ENV, SUPERVISOR_TOKEN_ENV, WORKSPACE_PORT } from "./container-spec.js";
import type {
  CreateContainerOpts,
  InspectedSessionContainer,
  ListedSessionContainer,
  SessionDockerClient,
  SessionDockerContainer,
  WaitResult,
} from "./docker-api.js";
import type { EngineDockerClient } from "./session-container-engine.js";

export interface FakeContainer {
  id: string;
  name: string;
  opts: CreateContainerOpts;
  ip: string;
  status: "created" | "running" | "exited";
  exitCode: number;
  /** Its supervisor, an app container's, and the app it serves. */
  supervisor?: FakeSupervisor;
  app?: string;
  servers: Server[];
  waiters: Array<(result: WaitResult) => void>;
}

const notFound = () => Object.assign(new Error("no such container"), { statusCode: 404 });
const conflict = () => Object.assign(new Error("name in use"), { statusCode: 409 });

// Test files run concurrently in one process (and in several), each with its own
// copy of this module, so each takes its own 127.x.y block of loopback addresses.
const ADDRESS_BLOCK = `127.${1 + (process.pid % 250)}.${1 + (threadId % 250)}`;
let nextAddress = 20;

function envOf(opts: CreateContainerOpts): Record<string, string> {
  return Object.fromEntries(opts.Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
}

/**
 * A daemon whose containers come up on a loopback address of their own: the
 * workspace surface on its port, and a supervisor speaking the protocol on an
 * app container's listen port, accepting the token its env carries. Everything
 * the runner sent is kept as it was sent.
 */
export class FakeEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly created: CreateContainerOpts[] = [];
  readonly removed: string[] = [];
  readonly workspaceWrites: unknown[] = [];
  /** The generation supervisors started from now on claim. */
  generation = 1;
  apiVersion = "1.47";
  private sequence = 0;

  readonly docker: SessionDockerClient & EngineDockerClient = {
    ping: async () => "OK",
    version: async () => ({ ApiVersion: this.apiVersion }),
    getVolume: () => ({ inspect: async () => ({}) }),
    getNetwork: () => ({ inspect: async () => ({}) }),
    getImage: () => ({ inspect: async () => ({}) }),
    pull: async () => Readable.from([]),
    modem: {
      followProgress: (stream: NodeJS.ReadableStream, done: (err: Error | null, out: unknown[]) => void) => {
        stream.on("end", () => done(null, []));
        stream.resume();
      },
    },
    createContainer: async (opts: CreateContainerOpts) => this.create(opts),
    getContainer: (id: string) => this.handle(id),
    listContainers: async ({ filters }: { all: true; filters?: string }) => {
      const wanted: string[] = filters ? (JSON.parse(filters).label ?? []) : [];
      return [...this.containers.values()]
        .filter((c) => wanted.every((term) => {
          const [key, value] = term.split("=");
          return c.opts.Labels[key!] === value;
        }))
        .map((c): ListedSessionContainer => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.opts.Labels }));
    },
  } as unknown as SessionDockerClient & EngineDockerClient;

  /** Create and start a container as an earlier runner process did, its
   *  supervisor (if an app's) answering with `live` as its run. */
  async stand(opts: CreateContainerOpts, live?: string): Promise<FakeContainer> {
    const container = this.create(opts);
    await container.start();
    const found = this.byName(opts.name)!;
    if (found.supervisor) found.supervisor.live = live;
    return found;
  }

  /** Put a container whose create options were never the runner's. */
  put(name: string, labels: Record<string, string>): void {
    this.sequence += 1;
    const id = `id-${this.sequence}`;
    this.containers.set(id, {
      id,
      name,
      opts: { name, Labels: labels, Env: [] } as unknown as CreateContainerOpts,
      ip: "",
      status: "running",
      exitCode: 0,
      servers: [],
      waiters: [],
    });
  }

  /** The container's main process ends with `code`. */
  async end(name: string, code: number): Promise<void> {
    const c = this.byName(name);
    if (!c) throw new Error(`no container '${name}'`);
    c.status = "exited";
    c.exitCode = code;
    await closeAll(c);
    for (const w of c.waiters.splice(0)) w({ StatusCode: code });
  }

  byName(name: string): FakeContainer | undefined {
    return [...this.containers.values()].find((c) => c.name === name);
  }

  names(): string[] {
    return [...this.containers.values()].map((c) => c.name).sort();
  }

  supervisorOf(app: string): FakeSupervisor {
    const found = [...this.containers.values()].find((c) => c.app === app)?.supervisor;
    if (!found) throw new Error(`no supervisor for '${app}'`);
    return found;
  }

  async close(): Promise<void> {
    for (const c of this.containers.values()) await closeAll(c);
    this.containers.clear();
  }

  private create(opts: CreateContainerOpts): SessionDockerContainer {
    if (this.byName(opts.name)) throw conflict();
    this.created.push(structuredClone(opts));
    this.sequence += 1;
    const id = `id-${this.sequence}`;
    this.containers.set(id, {
      id,
      name: opts.name,
      opts,
      ip: `${ADDRESS_BLOCK}.${nextAddress++}`,
      status: "created",
      exitCode: 0,
      servers: [],
      waiters: [],
    });
    return this.handle(id);
  }

  private find(idOrName: string): FakeContainer | undefined {
    return this.containers.get(idOrName) ?? this.byName(idOrName);
  }

  private handle(idOrName: string): SessionDockerContainer {
    const get = () => {
      const c = this.find(idOrName);
      if (!c) throw notFound();
      return c;
    };
    return {
      id: this.find(idOrName)?.id ?? idOrName,
      start: async () => this.start(get()),
      inspect: async () => inspection(get()),
      wait: async () => {
        const c = get();
        if (c.status === "exited") return { StatusCode: c.exitCode };
        return new Promise<WaitResult>((resolve) => c.waiters.push(resolve));
      },
      remove: async () => {
        const c = get();
        this.containers.delete(c.id);
        this.removed.push(c.name);
        await closeAll(c);
        for (const w of c.waiters.splice(0)) w({ StatusCode: 137 });
      },
    };
  }

  private async start(c: FakeContainer): Promise<void> {
    c.status = "running";
    const role = c.opts.Labels[ROLE_LABEL];
    if (role === "workspace") c.servers.push(await this.workspaceServer(c.ip));
    if (role === "app") {
      const env = envOf(c.opts);
      const port = Number(env[SUPERVISOR_LISTEN_ENV]!.split(":")[1]);
      c.app = c.name.replace(/^.*-app-/, "");
      c.supervisor = await FakeSupervisor.start({
        host: c.ip,
        port,
        token: env[SUPERVISOR_TOKEN_ENV]!,
        generation: this.generation,
      });
    }
  }

  private async workspaceServer(ip: string): Promise<Server> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "POST") {
          this.workspaceWrites.push(JSON.parse(body));
          res.end(JSON.stringify({ written: 1, deleted: 0 }));
        } else {
          res.end(JSON.stringify({ files: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(WORKSPACE_PORT, ip, resolve));
    return server;
  }
}

function inspection(c: FakeContainer): InspectedSessionContainer {
  const network = c.opts.HostConfig?.NetworkMode;
  return {
    Id: c.id,
    Name: `/${c.name}`,
    Config: { Image: c.opts.Image, Env: c.opts.Env, Labels: c.opts.Labels },
    State: { Status: c.status, Running: c.status === "running", ExitCode: c.exitCode },
    NetworkSettings: { Networks: network && c.ip ? { [network]: { IPAddress: c.ip } } : {} },
  };
}

async function closeAll(c: FakeContainer): Promise<void> {
  const servers = c.servers.splice(0);
  await Promise.all([
    c.supervisor?.close(),
    ...servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  ]);
}

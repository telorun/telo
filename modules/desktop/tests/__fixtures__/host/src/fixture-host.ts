// A desktop_host-1 host written from kernel/specs/desktop-host.md alone: the codec is the
// SDK's frame, the envelope and the answers are this file's reading of the spec.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  decodeTypedFrame,
  encodeFrame,
  encodeTypedFrame,
  FrameReader,
  integerInput,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";

interface HostResource extends ResourceManifest {
  host: unknown;
  generation?: string;
  expectedToken?: string;
  trayAvailable?: boolean;
  answerHello?: boolean;
  dropAfterOpen?: boolean;
}

interface Received {
  type: string;
  payload: unknown;
}

const plain = (value: unknown): unknown =>
  typeof value === "bigint"
    ? Number(value)
    : Array.isArray(value)
      ? value.map(plain)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
        : value;

export class FixtureHost {
  readonly received: Received[] = [];
  private socket: net.Socket | undefined;
  private nextId = 2;

  constructor(
    private readonly resource: HostResource,
    private readonly ctx: ResourceContext,
  ) {}

  init() {
    const need = this.ctx.resolveNeed("/host");
    const socketPath = String((need.fields.endpoint as { path: string }).path);
    const token = this.resource.expectedToken ?? String(need.fields.token);
    return this.ctx.effect("fixture host socket", async () => {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      const server = net.createServer((socket) => this.serve(socket, token));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      return {
        result: undefined,
        inverse: async () => {
          this.socket?.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
        },
      };
    });
  }

  send(type: string, payload: unknown): void {
    if (!this.socket) throw new Error("the fixture host has no connection to send on");
    const id = this.nextId;
    this.nextId += 2;
    this.socket.write(encodeFrame("message", encodeTypedFrame({ id, payload: plain(payload), type })));
  }

  private serve(socket: net.Socket, token: string): void {
    this.socket = socket;
    const reader = new FrameReader();
    let greeted = false;
    const answer = (id: number, type: string, body: unknown) =>
      socket.write(encodeFrame("message", encodeTypedFrame({ id, payload: body, type })));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      for (const frame of reader.push(chunk)) {
        const { id, type, payload } = decodeTypedFrame(frame.meta) as { id: number; type: string; payload: any };
        this.received.push({ payload, type });
        if (type === "Host.Hello") {
          if (this.resource.answerHello === false) continue;
          if (payload.token !== token) {
            answer(id, type, { error: { code: "ERR_DESKTOP_HOST_TOKEN_INVALID", message: "the token does not match this host's" } });
            socket.end();
            return;
          }
          greeted = true;
          answer(id, type, { ok: { generation: this.resource.generation ?? "desktop_host-1" } });
        } else if (!greeted) {
          answer(id, type, { error: { code: "ERR_DESKTOP_HOST_REQUEST_FAILED", message: "no Host.Hello yet" } });
        } else if (type === "Tray.Open") {
          answer(id, type, { ok: { available: this.resource.trayAvailable ?? true } });
        } else {
          answer(id, type, { ok: {} });
          // A host that quits the application goes away with it.
          if (type === "Host.Quit" || (type === "Window.Open" && this.resource.dropAfterOpen)) socket.end();
        }
      }
    });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const Host = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: HostResource, ctx: ResourceContext) {
    return new FixtureHost(resource, ctx);
  },
};

interface HostRef extends ResourceManifest {
  fixture: unknown;
}

const isHost = (candidate: unknown): candidate is FixtureHost => candidate instanceof FixtureHost;

export const Frames = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: HostRef, ctx: ResourceContext) {
    return {
      async invoke() {
        const host = ctx.resolveRef(resource.fixture, isHost, () => "Fixture.Frames: 'fixture'");
        return { frames: host.received.map((frame) => ({ payload: frame.payload, type: frame.type })) };
      },
      snapshot: () => ({}),
    };
  },
};

export const Send = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: HostRef, ctx: ResourceContext) {
    return {
      async invoke(inputs: { type: string; payload: unknown }) {
        ctx.resolveRef(resource.fixture, isHost, () => "Fixture.Send: 'fixture'").send(inputs.type, inputs.payload);
        return {};
      },
      snapshot: () => ({}),
    };
  },
};

export class RecorderInstance {
  readonly calls: unknown[] = [];
  private waiters: Array<() => void> = [];

  record(inputs: unknown): void {
    this.calls.push(plain(inputs));
    for (const wake of this.waiters.splice(0)) wake();
  }

  async until(count: number, timeoutMs: number): Promise<unknown[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.calls.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`expected ${count} recorded calls, saw ${this.calls.length}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.calls;
  }
}

const isRecorder = (candidate: unknown): candidate is RecorderInstance => candidate instanceof RecorderInstance;

export const Recorder = {
  schema: { type: "object", additionalProperties: true },
  async create() {
    const recorder = new RecorderInstance();
    return Object.assign(recorder, {
      async invoke(inputs: unknown) {
        recorder.record(inputs);
        return {};
      },
      snapshot: () => ({}),
    });
  },
};

export const Calls = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: ResourceManifest & { recorder: unknown }, ctx: ResourceContext) {
    return {
      async invoke(inputs: { count: unknown }) {
        const recorder = ctx.resolveRef(resource.recorder, isRecorder, () => "Fixture.Calls: 'recorder'");
        return { calls: await recorder.until(integerInput(inputs.count), 5000) };
      },
      snapshot: () => ({}),
    };
  },
};

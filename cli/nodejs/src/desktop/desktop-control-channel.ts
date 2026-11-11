import { decodeTypedFrame, encodeFrame, encodeTypedFrame, FrameReader, FrameRefusal, type Frame } from "@telorun/sdk";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The host end of `desktop_host-1` (`kernel/specs/desktop-host.md` §1–§4): a
 * local socket (a named pipe on Windows) of `telo run`'s own, in a fresh
 * directory only this user can enter, and a fresh `token`. Each connection
 * must open with `Host.Hello` carrying the token; every frame the table
 * refuses is terminal and closes the connection. Requests are handed to the
 * {@link ControlHandler}; the host's notifications carry even ids.
 */

export const DESKTOP_HOST_GENERATION = "desktop_host-1";

export interface Size {
  width: number;
  height: number;
}

export interface WindowOpenRequest {
  window: string;
  path: string;
  title?: string;
  size?: Size;
  minSize?: Size;
  resizable: boolean;
  visible: boolean;
  onClose: "close" | "hide";
}

export type MenuEntry = { type: "item"; item: number; label: string; enabled: boolean } | { type: "separator" };

export interface TrayOpenRequest {
  tray: string;
  icon: string;
  monochrome: boolean;
  tooltip?: string;
  menu: MenuEntry[];
}

export type ControlRequest =
  | { type: "Host.Quit"; payload: Record<string, never> }
  | { type: "Window.Open"; payload: WindowOpenRequest }
  | { type: "Window.Show"; payload: { window: string } }
  | { type: "Window.Close"; payload: { window: string } }
  | { type: "Tray.Open"; payload: TrayOpenRequest }
  | { type: "Tray.Close"; payload: { tray: string } };

export interface ControlNotifications {
  "Window.Closed": { window: string };
  "Tray.ItemChosen": { tray: string; item: number };
  "Tray.Clicked": { tray: string };
}

/** A request the host answers with an `error` response. */
export class ControlRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlRefusal";
  }
}

export interface ControlConnection {
  readonly id: number;
  notify<K extends keyof ControlNotifications>(type: K, payload: ControlNotifications[K]): void;
}

export interface ControlHandler {
  /** Resolves with the `ok` body; a {@link ControlRefusal} is answered as its code. */
  handle(connection: ControlConnection, request: ControlRequest): Promise<unknown>;
  /** The connection ended, however it ended. */
  ended(connection: ControlConnection): void;
  /** Why a connection was closed for a frame the protocol refuses. */
  violated(reason: string): void;
}

export interface ControlChannel {
  /** The need's `endpoint` field: `unix://<path>` or `npipe:////./pipe/<name>`. */
  readonly endpoint: string;
  /** The need's `token` field. */
  readonly token: string;
  close(): Promise<void>;
  /** Removes the socket and its directory at once; for a process that is exiting. */
  removeNow(): void;
}

export interface ControlChannelOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export async function openControlChannel(
  handler: ControlHandler,
  options: ControlChannelOptions = {},
): Promise<ControlChannel> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const token = randomBytes(32).toString("base64url");
  const place = controlPlace(platform, env);
  let nextConnection = 1;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    new HostEnd(socket, nextConnection++, token, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(place.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (platform !== "win32") fs.chmodSync(place.socketPath, 0o600);
  const removeNow = (): void => {
    if (place.directory) fs.rmSync(place.directory, { recursive: true, force: true });
  };
  let closed: Promise<void> | undefined;
  return {
    endpoint: place.endpoint,
    token,
    close() {
      closed ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          removeNow();
          resolve();
        });
      });
      return closed;
    },
    removeNow,
  };
}

interface ControlPlace {
  socketPath: string;
  endpoint: string;
  directory?: string;
}

function controlPlace(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ControlPlace {
  if (platform === "win32") {
    const name = `telo-desktop-${randomBytes(16).toString("hex")}`;
    return { socketPath: `\\\\.\\pipe\\${name}`, endpoint: `npipe:////./pipe/${name}` };
  }
  // A directory mkdtemp creates is 0700, so only this user can reach the socket.
  // `<base>/telo-desktop-XXXXXX/control.sock` must fit `sun_path` (103 bytes, macOS's).
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  const fits = (base: string) => Buffer.byteLength(path.join(base, "telo-desktop-XXXXXX", "control.sock")) <= 103;
  const base = runtime && path.isAbsolute(runtime) && fits(runtime) ? runtime : fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, "telo-desktop-"));
  const socketPath = path.join(directory, "control.sock");
  return { socketPath, endpoint: `unix://${socketPath}`, directory };
}

class HostEnd implements ControlConnection {
  private readonly reader = new FrameReader();
  private greeted = false;
  private closed = false;
  private nextNotification = 2;
  private readonly outstanding = new Set<number>();

  constructor(
    private readonly socket: net.Socket,
    readonly id: number,
    private readonly token: string,
    private readonly handler: ControlHandler,
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.closed = true;
      if (this.greeted) handler.ended(this);
    });
  }

  notify<K extends keyof ControlNotifications>(type: K, payload: ControlNotifications[K]): void {
    if (this.closed) return;
    const id = this.nextNotification;
    this.nextNotification += 2;
    this.write(id, type, payload);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    try {
      for (const frame of this.reader.push(chunk)) {
        this.dispatch(frame);
        if (this.closed) return;
      }
    } catch (err) {
      this.violate(err instanceof Error ? err.message : String(err));
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.class !== "message") throw new FrameRefusal("a data frame, which this protocol does not carry");
    let envelope: unknown;
    try {
      envelope = decodeTypedFrame(frame.meta);
    } catch (err) {
      throw new FrameRefusal(`a meta that is not a typed frame (${(err as Error).message})`);
    }
    const { id, type, payload } = envelopeOf(envelope);
    if (id % 2 === 0) throw new FrameRefusal(`an even id ${id}: the module end mints odd ids, and the host awaits no response`);
    if (this.outstanding.has(id)) throw new FrameRefusal(`id ${id}, which a request still outstanding bears`);
    if (!this.greeted) {
      if (type !== "Host.Hello") throw new FrameRefusal(`'${type}' before Host.Hello`);
      this.hello(id, payload);
      return;
    }
    if (type === "Host.Hello") throw new FrameRefusal("a second Host.Hello");
    const request = requestOf(type, payload);
    this.outstanding.add(id);
    this.handler.handle(this, request).then(
      (ok) => this.answer(id, type, { ok: ok ?? {} }),
      (err: unknown) => {
        const refusal =
          err instanceof ControlRefusal
            ? err
            : new ControlRefusal("ERR_DESKTOP_HOST_REQUEST_FAILED", err instanceof Error ? err.message : String(err));
        this.answer(id, type, { error: { code: refusal.code, message: refusal.message } });
      },
    );
  }

  private hello(id: number, payload: unknown): void {
    const fault = closedObjectFault(payload, { generation: "string", token: "string" }, []);
    if (fault) throw new FrameRefusal(`Host.Hello with ${fault}`);
    const { token } = payload as { generation: string; token: string };
    if (!sameSecret(token, this.token)) {
      this.write(id, "Host.Hello", {
        error: { code: "ERR_DESKTOP_HOST_TOKEN_INVALID", message: "the token does not match this desktop host's" },
      });
      this.closed = true;
      this.socket.end();
      return;
    }
    this.greeted = true;
    this.write(id, "Host.Hello", { ok: { generation: DESKTOP_HOST_GENERATION } });
  }

  private answer(id: number, type: string, payload: unknown): void {
    this.outstanding.delete(id);
    if (!this.closed) this.write(id, type, payload);
  }

  private write(id: number, type: string, payload: unknown): void {
    this.socket.write(encodeFrame("message", encodeTypedFrame({ id, payload, type })));
  }

  private violate(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.handler.violated(reason);
    this.socket.destroy();
  }
}

/** Whether two secrets are equal, in time independent of where they differ. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function envelopeOf(value: unknown): { id: number; type: string; payload: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FrameRefusal("a meta that is not an envelope");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "id,payload,type") throw new FrameRefusal(`an envelope with members '${keys}', not id, payload and type`);
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    throw new FrameRefusal("an envelope whose id is not a whole non-negative number");
  }
  if (typeof record.type !== "string") throw new FrameRefusal("an envelope whose type is not text");
  return { id, type: record.type, payload: record.payload };
}

type Check = "string" | "boolean" | "count" | "size" | "path" | "onClose" | "menu";

const REQUESTS: Record<ControlRequest["type"], { members: Record<string, Check>; optional: string[] }> = {
  "Host.Quit": { members: {}, optional: [] },
  "Window.Open": {
    members: {
      window: "string",
      path: "path",
      title: "string",
      size: "size",
      minSize: "size",
      resizable: "boolean",
      visible: "boolean",
      onClose: "onClose",
    },
    optional: ["title", "size", "minSize"],
  },
  "Window.Show": { members: { window: "string" }, optional: [] },
  "Window.Close": { members: { window: "string" }, optional: [] },
  "Tray.Open": {
    members: { tray: "string", icon: "string", monochrome: "boolean", tooltip: "string", menu: "menu" },
    optional: ["tooltip"],
  },
  "Tray.Close": { members: { tray: "string" }, optional: [] },
};

function requestOf(type: string, payload: unknown): ControlRequest {
  if (!Object.hasOwn(REQUESTS, type)) throw new FrameRefusal(`a message of unknown type '${type}'`);
  const table = REQUESTS[type as ControlRequest["type"]];
  const fault = closedObjectFault(payload, table.members, table.optional);
  if (fault) throw new FrameRefusal(`${type} with ${fault}`);
  return { type, payload } as ControlRequest;
}

function closedObjectFault(payload: unknown, members: Record<string, Check>, optional: string[]): string | undefined {
  if (!isRecord(payload)) return "a payload that is not an object";
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(members, key)) return `a member '${key}' its table does not list`;
  }
  for (const [key, check] of Object.entries(members)) {
    const value = payload[key];
    if (value === undefined) {
      if (optional.includes(key)) continue;
      return `no member '${key}'`;
    }
    if (!fits(check, value)) return `a member '${key}' of the wrong shape`;
  }
  return undefined;
}

function fits(check: Check, value: unknown): boolean {
  switch (check) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "path":
      return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
    case "onClose":
      return value === "close" || value === "hide";
    case "size":
      return (
        isRecord(value) &&
        Object.keys(value).sort().join(",") === "height,width" &&
        [value.width, value.height].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
      );
    case "menu":
      return Array.isArray(value) && value.every(menuEntryFits);
  }
}

function menuEntryFits(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.type === "separator") return Object.keys(entry).length === 1;
  return (
    entry.type === "item" &&
    closedObjectFault(entry, { type: "string", item: "count", label: "string", enabled: "boolean" }, []) === undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

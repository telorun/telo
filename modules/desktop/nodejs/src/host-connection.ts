import * as net from "node:net";
import {
  decodeTypedFrame,
  encodeFrame,
  encodeTypedFrame,
  FrameReader,
  FrameRefusal,
  InvokeError,
  type Frame,
} from "@telorun/sdk";

/** The generation of the desktop-host protocol this module speaks (`kernel/specs/desktop-host.md`). */
export const GENERATION = "desktop_host-1";

/** How long a host that accepted the connection has to answer `Host.Hello`. */
export const HANDSHAKE_TIMEOUT_MS = 5000;

type Notification = (payload: any) => void;

/** Told how the connection ended: the failure, or `undefined` for an end this module caused. */
export type EndListener = (failure: InvokeError | undefined) => void;

interface Pending {
  type: string;
  resolve: (ok: any) => void;
  reject: (err: Error) => void;
}

/** What an `endpoint` URL names: a socket path, or a Windows named pipe. */
export function socketPathOf(endpoint: { scheme: string; path?: string }): string {
  const path = endpoint.path ?? "";
  if (endpoint.scheme === "npipe") return path.replace(/\//g, "\\");
  return path;
}

/**
 * One connection to a desktop host: the framed carrier of `desktop_host-1`. The module
 * end mints odd ids; the host's even ids are notifications.
 */
export class HostConnection {
  private readonly reader = new FrameReader();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Notification>>();
  private nextId = 1;
  private failure: InvokeError | undefined;
  private readonly closeListeners = new Set<EndListener>();
  private endReport: InvokeError | undefined;
  private expectEnd = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly endpointText: string,
  ) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("end", () => this.fail(this.unreachable("closed the connection")));
    socket.on("error", (err) => this.fail(this.unreachable(err.message)));
    socket.on("close", () => this.fail(this.unreachable("closed the connection")));
  }

  /** Dials the host and completes the handshake; refuses a wrong token or generation. */
  static async open(endpoint: { scheme: string; path?: string }, endpointText: string, token: string): Promise<HostConnection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ path: socketPathOf(endpoint) });
      s.once("connect", () => resolve(s));
      s.once("error", (err) =>
        reject(
          new InvokeError("ERR_DESKTOP_HOST_UNREACHABLE", `the desktop host at ${endpointText} could not be reached: ${err.message}`),
        ),
      );
    });
    const connection = new HostConnection(socket, endpointText);
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = connection.request("Host.Hello", { generation: GENERATION, token });
      // A timeout abandons this promise; closing the connection then rejects it, observed by the race.
      answer.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new InvokeError(
                "ERR_DESKTOP_HOST_UNREACHABLE",
                `the desktop host at ${endpointText} accepted the connection but never answered Host.Hello within ${HANDSHAKE_TIMEOUT_MS} ms`,
              ),
            ),
          HANDSHAKE_TIMEOUT_MS,
        );
      });
      const hello = await Promise.race([answer, timeout]);
      if (hello?.generation !== GENERATION) {
        throw new InvokeError(
          "ERR_DESKTOP_HOST_INCOMPATIBLE",
          `the desktop host at ${endpointText} speaks ${String(hello?.generation)}; this module speaks ${GENERATION}`,
        );
      }
    } catch (err) {
      connection.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return connection;
  }

  /** Sends a request and resolves with the `ok` body of its response. */
  request(type: string, payload: Record<string, unknown>): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    // The host goes away with the application it quits: that end is the one this module asked for.
    if (type === "Host.Quit") this.expectEnd = true;
    const id = this.nextId;
    this.nextId += 2;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { type, resolve, reject });
      this.socket.write(encodeFrame("message", encodeTypedFrame({ id, payload, type })));
    });
  }

  /** Subscribes to a host notification; returns the unsubscribe. */
  on(type: string, listener: Notification): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Calls `listener` once the connection has ended, however it ended; returns the unsubscribe. */
  onEnd(listener: EndListener): () => void {
    if (this.failure) {
      listener(this.endReport);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get closed(): boolean {
    return this.failure !== undefined;
  }

  close(): void {
    this.expectEnd = true;
    this.fail(this.unreachable("connection closed"));
    this.socket.destroy();
  }

  private unreachable(reason: string): InvokeError {
    return new InvokeError("ERR_DESKTOP_HOST_UNREACHABLE", `the desktop host at ${this.endpointText} ${reason}`);
  }

  private receive(chunk: Uint8Array): void {
    try {
      for (const frame of this.reader.push(chunk)) this.dispatch(frame);
    } catch (err) {
      const reason = err instanceof FrameRefusal || err instanceof InvokeError ? err.message : String(err);
      this.expectEnd = false;
      this.fail(new InvokeError("ERR_DESKTOP_HOST_PROTOCOL_VIOLATION", `the desktop host at ${this.endpointText} sent a frame this module refuses: ${reason}`));
      this.socket.destroy();
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.class !== "message") throw new FrameRefusal("this protocol has no data frame");
    const envelope = decodeTypedFrame(frame.meta) as any;
    const members = envelope && typeof envelope === "object" ? Object.keys(envelope).sort().join(",") : "";
    if (members !== "id,payload,type" || !Number.isInteger(envelope.id) || envelope.id < 0 || typeof envelope.type !== "string") {
      throw new FrameRefusal("an envelope carries exactly id, type and payload");
    }
    if (envelope.id % 2 === 0) {
      this.notify(envelope.type, envelope.payload);
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending || pending.type !== envelope.type) {
      throw new FrameRefusal(`a response of type '${envelope.type}' answers no outstanding request`);
    }
    this.pending.delete(envelope.id);
    const body = envelope.payload;
    if (body && typeof body === "object" && "ok" in body) {
      pending.resolve(body.ok);
    } else if (body && typeof body === "object" && body.error && typeof body.error.code === "string") {
      pending.reject(new InvokeError(body.error.code, String(body.error.message ?? body.error.code)));
    } else {
      throw new FrameRefusal("a response payload carries exactly 'ok' or 'error'");
    }
  }

  private notify(type: string, payload: any): void {
    const valid =
      (type === "Window.Closed" && typeof payload?.window === "string") ||
      (type === "Tray.Clicked" && typeof payload?.tray === "string") ||
      (type === "Tray.ItemChosen" && typeof payload?.tray === "string" && Number.isInteger(payload?.item));
    if (!valid) throw new FrameRefusal(`'${type}' is not a notification of desktop_host-1, or its payload is malformed`);
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  private fail(err: InvokeError): void {
    if (this.failure) return;
    this.failure = err;
    this.endReport = this.expectEnd ? undefined : err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    for (const listener of this.closeListeners) listener(this.endReport);
    this.closeListeners.clear();
  }
}

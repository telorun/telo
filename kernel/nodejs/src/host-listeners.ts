import type { ClaimedListener, HandedConnection } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import type { Duplex } from "node:stream";

/** One connection a host admitted. */
export interface HostConnection {
  /** The admitted connection; the host keeps its own `error` listener on it. */
  socket: Duplex;
  /** The bytes the host already read from it while admitting it, replayed
   *  first to whichever server it reaches. */
  head?: Uint8Array;
  /** The connection's remote end, `<address>:<port>`. */
  peer: string;
}

/** What a connection no server can take is answered with, under `503`. */
export interface UnavailableResponse {
  contentType: string;
  body: string | Uint8Array;
}

export interface UnavailableContext {
  port: number;
  /** Why the application never started, when it did not. */
  failure?: unknown;
}

export interface HostListenersOptions {
  /** Each port number the host holds a socket for, and the address it is bound to. */
  ports: ReadonlyArray<{ port: number; address: string }>;
  /** The body of the `503` a connection is answered with when no server can take it. */
  unavailable(context: UnavailableContext): UnavailableResponse;
}

interface PortEntry {
  readonly port: number;
  readonly address: string;
  claim?: { id: string; accept: (connection: HandedConnection) => void };
  /** Set by a release: what arrives is held until the port is claimed anew. */
  released: boolean;
  /** Connections held for a claim, oldest first. */
  readonly held: HostConnection[];
  /** A claim's delivery of the held connections is still to run. */
  flushing: boolean;
}

interface ListenerTable {
  readonly options: HostListenersOptions;
  readonly ports: Map<number, PortEntry>;
  phase: "starting" | "started" | "stopped";
  failure?: unknown;
  /** The kernel that decides when startup ends; a kernel it starts only claims. */
  owner?: string;
  nextId: number;
}

const tables = new WeakMap<HostListeners, ListenerTable>();

/**
 * The sockets a process embedding the kernel owns itself and supplies, per `tcp`
 * port number, to whichever server is configured with that number
 * (`kernel/specs/controller-protocol.md` §9.4). The host admits each connection
 * and hands it to {@link admit}: it reaches the server holding the port's claim,
 * is held while none does during startup or after a claim was released, and is
 * otherwise answered `503` with the host's {@link HostListenersOptions.unavailable}
 * body. Passed to `new Kernel({ listeners })`; a child application the kernel
 * starts claims through the same set. One kernel at a time.
 */
export class HostListeners {
  constructor(options: HostListenersOptions) {
    const ports = new Map<number, PortEntry>();
    for (const { port, address } of options.ports) {
      if (ports.has(port)) throw new Error(`HostListeners: port ${port} is listed twice`);
      ports.set(port, { port, address, released: false, held: [], flushing: false });
    }
    tables.set(this, { options, ports, phase: "starting", nextId: 1 });
  }

  /** Hands an admitted connection to the port's server, holds it, or answers it. */
  admit(port: number, connection: HostConnection): void {
    const table = tableOf(this);
    const entry = table.ports.get(port);
    if (!entry) {
      throw new Error(`HostListeners: no socket is held for port ${port}; the ports held are ${[...table.ports.keys()].join(", ")}`);
    }
    if (entry.claim && !entry.flushing) {
      entry.claim.accept(handOver(connection));
    } else if (entry.claim || (table.phase !== "stopped" && (table.phase === "starting" || entry.released))) {
      hold(entry, connection);
    } else {
      answerUnavailable(table, entry.port, connection);
    }
  }
}

/** A kernel's side of a {@link HostListeners}. */
export interface KernelListeners {
  /** The address of the host's socket for `port`, if it holds one. */
  addressOf(port: number): string | undefined;
  claim(port: number, accept: (connection: HandedConnection) => void, holder: string): ClaimedListener | null;
  /** Startup has ended: answers what no claim can take, and returns the ports
   *  no server claimed. Nothing for a kernel that does not own the set. */
  startupEnded(): number[];
  /** Startup failed: what arrives without a claim is answered with `failure`.
   *  Nothing once startup has ended. */
  startupFailed(failure: unknown): void;
  /** The kernel has stopped: everything held is answered, and so is what arrives. */
  stopped(): void;
}

/** Attaches a kernel; the first attached while none owns the set owns it. */
export function attachListeners(listeners: HostListeners, kernelId: string): KernelListeners {
  const table = tableOf(listeners);
  const owns = table.owner === undefined;
  if (owns) {
    table.owner = kernelId;
    table.phase = "starting";
    table.failure = undefined;
  }
  const settle = (phase: ListenerTable["phase"]): void => {
    table.phase = phase;
    for (const entry of table.ports.values()) {
      if (entry.claim || (phase === "started" && entry.released)) continue;
      for (const connection of entry.held.splice(0)) answerUnavailable(table, entry.port, connection);
    }
  };
  return {
    addressOf: (port) => table.ports.get(port)?.address,
    claim(port, accept, holder) {
      const entry = table.ports.get(port);
      if (!entry) return null;
      if (entry.claim) {
        throw new RuntimeError(
          "ERR_LISTENER_CLAIMED",
          `${holder}: the host's socket for port ${port} is already claimed by another server`,
        );
      }
      const id = `l${table.nextId++}`;
      entry.claim = { id, accept };
      entry.released = false;
      // Delivered after the claim returns, so the holder has its handle first.
      entry.flushing = entry.held.length > 0;
      if (entry.flushing) {
        setImmediate(() => {
          entry.flushing = false;
          while (entry.claim?.id === id && entry.held.length > 0) accept(handOver(entry.held.shift()!));
        });
      }
      let released = false;
      return {
        address: entry.address,
        release: async () => {
          if (released) return;
          released = true;
          if (entry.claim?.id !== id) return;
          entry.claim = undefined;
          entry.flushing = false;
          entry.released = true;
        },
      };
    },
    startupEnded() {
      if (!owns || table.phase !== "starting") return [];
      const unclaimed = [...table.ports.values()].filter((entry) => !entry.claim && !entry.released);
      settle("started");
      return unclaimed.map((entry) => entry.port);
    },
    startupFailed(failure) {
      if (!owns || table.phase !== "starting") return;
      table.failure = failure;
      settle("started");
    },
    stopped() {
      if (!owns) return;
      settle("stopped");
      table.owner = undefined;
    },
  };
}

function tableOf(listeners: HostListeners): ListenerTable {
  const table = tables.get(listeners);
  if (!table) throw new Error("HostListeners: not constructed through its constructor");
  return table;
}

function hold(entry: PortEntry, connection: HostConnection): void {
  entry.held.push(connection);
  connection.socket.once("close", () => {
    const at = entry.held.indexOf(connection);
    if (at !== -1) entry.held.splice(at, 1);
  });
}

function answerUnavailable(table: ListenerTable, port: number, { socket }: HostConnection): void {
  const { contentType, body } = table.options.unavailable({
    port,
    ...(table.failure === undefined ? {} : { failure: table.failure }),
  });
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  socket.end(
    Buffer.concat([
      Buffer.from(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${bytes.length}\r\n` +
          "Cache-Control: no-store\r\n" +
          "Connection: close\r\n\r\n",
      ),
      bytes,
    ]),
  );
}

/** The connection as the protocol hands it over: an inbound channel opening
 *  with the replayed bytes, and an outbound one. */
function handOver({ socket, head, peer }: HostConnection): HandedConnection {
  return {
    peer,
    inbound: inboundOf(socket, head),
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        socket.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    close: (error) =>
      new Promise<void>((resolve) => {
        if (error) {
          socket.destroy();
          resolve();
          return;
        }
        socket.end(() => resolve());
      }),
  };
}

async function* inboundOf(socket: Duplex, head: Uint8Array | undefined): AsyncIterable<Uint8Array> {
  if (head && head.length > 0) yield head;
  for await (const chunk of socket) yield typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
}

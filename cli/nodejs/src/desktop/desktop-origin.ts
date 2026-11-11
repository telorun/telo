import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import type { HeldInstanceLock } from "./single-instance-lock.js";

/**
 * The window's two origins (`kernel/specs/desktop-host.md` §5.3). The
 * application's: `127.0.0.1` on a port that stays the same across launches,
 * because browser storage and permission grants are keyed by origin. The host's
 * ({@link bindHostOrigin}): `127.0.0.1` on a port the OS assigns at every launch,
 * serving the host's own pages, recorded nowhere and never handed to the kernel.
 *
 * The port is the root's `ports:` `default:` when it declares one (so an author
 * can register an exact redirect address with an identity provider), else the
 * one recorded in `<app directory>/desktop-host/port`, OS-assigned on the first
 * start. When the port tried cannot be bound, or the file is present and holds
 * no port, a new OS-assigned one is recorded and `DESKTOP_ORIGIN_CHANGED` is
 * warned. No file yet is a first start and says nothing.
 *
 * The file is read and replaced only under the lock: every call takes the
 * {@link HeldInstanceLock}. The returned server is already listening, for the
 * caller to attach `connection` handling and hand to the kernel's listeners.
 */

export const DESKTOP_ORIGIN_CHANGED = "DESKTOP_ORIGIN_CHANGED";

export interface OriginWarning {
  code: typeof DESKTOP_ORIGIN_CHANGED;
  message: string;
}

export interface BoundOrigin {
  server: net.Server;
  port: number;
  /** `http://127.0.0.1:<port>` */
  origin: string;
}

export interface OriginOptions {
  /** The `default:` of the root's `ports:` entry the need names, when it declares one. */
  declaredPort?: number;
  warn: (warning: OriginWarning) => void;
}

const ADDRESS = "127.0.0.1";

export function originOf(port: number): string {
  return `http://${ADDRESS}:${port}`;
}

export async function bindOrigin(lock: HeldInstanceLock, options: OriginOptions): Promise<BoundOrigin> {
  const portFile = path.join(lock.directory, "port");
  const recorded = readRecordedPort(portFile);

  if (options.declaredPort !== undefined) {
    const bound = await listen(options.declaredPort);
    if (bound.ok) return finish(bound.server);
    const fresh = await listenAnywhere();
    recordPort(portFile, fresh.port);
    options.warn(changed(`the root's ports entry declares default ${options.declaredPort}`, bound.reason, options.declaredPort, fresh.port));
    return finish(fresh.server);
  }

  if (recorded.kind === "absent") {
    const fresh = await listenAnywhere();
    recordPort(portFile, fresh.port);
    return finish(fresh.server);
  }
  if (recorded.kind === "port") {
    const bound = await listen(recorded.port);
    if (bound.ok) return finish(bound.server);
    const fresh = await listenAnywhere();
    recordPort(portFile, fresh.port);
    options.warn(changed(`${portFile} named ${recorded.port}`, bound.reason, recorded.port, fresh.port));
    return finish(fresh.server);
  }
  const fresh = await listenAnywhere();
  recordPort(portFile, fresh.port);
  options.warn({
    code: DESKTOP_ORIGIN_CHANGED,
    message: `${portFile} holds no port; the window's origin is now ${originOf(fresh.port)}, so what the page kept in browser storage starts empty`,
  });
  return finish(fresh.server);
}

/** The host origin's listener: a fresh OS-assigned port on loopback. */
export async function bindHostOrigin(): Promise<BoundOrigin> {
  return finish((await listenAnywhere()).server);
}

function changed(subject: string, reason: string, from: number, to: number): OriginWarning {
  const why = reason === "EADDRINUSE" ? "is in use" : `cannot be bound (${reason})`;
  return {
    code: DESKTOP_ORIGIN_CHANGED,
    message: `${subject}, which ${why}; the window's origin is now ${originOf(to)} instead of ${originOf(from)}, so what the page kept in browser storage starts empty`,
  };
}

function finish(server: net.Server): BoundOrigin {
  const port = (server.address() as net.AddressInfo).port;
  return { server, port, origin: originOf(port) };
}

type Recorded = { kind: "absent" } | { kind: "invalid" } | { kind: "port"; port: number };

function readRecordedPort(file: string): Recorded {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  const port = /^[0-9]{1,5}$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65535 ? { kind: "port", port } : { kind: "invalid" };
}

/** Written under a name of its own and moved into place, so a crash never leaves half a port. */
function recordPort(file: string, port: number): void {
  const partial = `${file}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${port}\n`, { mode: 0o600 });
  fs.renameSync(partial, file);
}

type Listening = { ok: true; server: net.Server } | { ok: false; reason: string };

function listen(port: number): Promise<Listening> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve({ ok: false, reason: err.code ?? err.message }));
    server.listen({ host: ADDRESS, port, exclusive: true }, () => {
      server.removeAllListeners("error");
      resolve({ ok: true, server });
    });
  });
}

async function listenAnywhere(): Promise<{ server: net.Server; port: number }> {
  const bound = await listen(0);
  if (!bound.ok) throw new Error(`no port on ${ADDRESS} could be bound (${bound.reason})`);
  return { server: bound.server, port: (bound.server.address() as net.AddressInfo).port };
}

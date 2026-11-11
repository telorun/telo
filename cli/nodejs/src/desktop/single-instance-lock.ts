import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { desktopHostDirectory } from "./desktop-app-directory.js";

/**
 * The single-instance lock of one desktop application: a local socket (a named
 * pipe on Windows) per `identifier`, held for the life of the first start.
 *
 * **Liveness is tested by connecting.** A socket file a crashed instance left
 * behind refuses the connection and is replaced; one that answers is a running
 * instance. A second start sends `show` and is answered `{ pid, source }` by the
 * first, after the first has run its `onShowWindows` callback; it never takes
 * the lock. The wire is JSON lines: one request line `{"type":"show"}`, one
 * response line `{"pid":<n>,"source":"<text>"}`, then the connection closes.
 *
 * **Where the socket lives.** `<app directory>/desktop-host/instance.sock` on
 * Unix, unless that path would exceed the `sun_path` limit (103 bytes, the
 * smallest of macOS and Linux); then a short deterministic path of the same
 * identifier under the first of `$XDG_RUNTIME_DIR` and the OS temp directory where it fits, in a
 * per-user `telo-desktop-<uid>` directory made `0700`. On Windows
 * `\\.\pipe\telo-desktop-<hash of the identifier and the app directory>`, so the name is per user.
 *
 * The port file and the webview data are the lock holder's alone: nothing in
 * `desktop-host/` is touched without a {@link HeldInstanceLock}.
 */

const SUN_PATH_LIMIT = 103;
const PROBE_TIMEOUT_MS = 5000;

export interface InstanceLockOptions {
  identifier: string;
  /** The per-user application directory (`userAppDirectory`). */
  appDirectory: string;
  /** What this start runs — a manifest path or a packaged app's name — told to a second start. */
  source: string;
  /** Shows again every window the first start showed; awaited before a second start is answered. */
  onShowWindows: () => void | Promise<void>;
  platform?: NodeJS.Platform;
  /** Replaces `process.pid` in the answer (tests). */
  pid?: number;
  env?: NodeJS.ProcessEnv;
  /** Receives an error of the listening socket after the lock is held; unset, it is thrown asynchronously as an unhandled emitter error. */
  onError?: (error: Error) => void;
}

export interface HeldInstanceLock {
  readonly acquired: true;
  /** `<app directory>/desktop-host/`, created `0700`. */
  readonly directory: string;
  /** Stops answering and removes the socket. Idempotent. */
  release(): Promise<void>;
}

export interface RunningInstance {
  readonly acquired: false;
  readonly pid: number;
  readonly source: string;
}

export async function acquireInstanceLock(options: InstanceLockOptions): Promise<HeldInstanceLock | RunningInstance> {
  const platform = options.platform ?? process.platform;
  const directory = desktopHostDirectory(options.appDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const endpoint = lockEndpoint(options.identifier, directory, platform, options.env ?? process.env);

  // A stale socket is removed and listening retried once; a second contention
  // is another start winning the same race, which the probe then reports.
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = await tryListen(endpoint, options);
    if (server) return held(server, endpoint, directory, platform);
    const running = await probe(endpoint);
    if (running) return running;
    if (platform !== "win32") fs.rmSync(endpoint, { force: true });
  }
  throw new Error(`the single-instance socket ${endpoint} is neither free nor answering`);
}

/** The line a second start prints before it exits 0. */
export function alreadyRunningLine(running: RunningInstance, productName: string): string {
  return `${productName} is already running (process ${running.pid}, ${running.source}); its windows are shown`;
}

export function lockEndpoint(identifier: string, directory: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha256").update(identifier).update("\0").update(directory).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\telo-desktop-${hash}`;
  const preferred = path.join(directory, "instance.sock");
  if (Buffer.byteLength(preferred) <= SUN_PATH_LIMIT) return preferred;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  const candidates = [...(runtime && path.isAbsolute(runtime) ? [runtime] : []), fs.realpathSync(os.tmpdir())];
  for (const base of candidates) {
    const shortDirectory = path.join(base, `telo-desktop-${uid}`);
    const socket = path.join(shortDirectory, `${hash}.sock`);
    if (Buffer.byteLength(socket) > SUN_PATH_LIMIT) continue;
    fs.mkdirSync(shortDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(shortDirectory, 0o700);
    return socket;
  }
  throw new Error(
    `no directory for the single-instance socket: the path would exceed ${SUN_PATH_LIMIT} bytes under ${candidates.join(" and ")}`,
  );
}

function tryListen(endpoint: string, options: InstanceLockOptions): Promise<net.Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((connection) => answer(connection, options));
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(undefined);
      else reject(err);
    });
    server.listen(endpoint, () => {
      server.removeAllListeners("error");
      if (options.onError) server.on("error", options.onError);
      resolve(server);
    });
  });
}

function answer(connection: net.Socket, options: InstanceLockOptions): void {
  let buffered = "";
  connection.setEncoding("utf8");
  connection.on("error", () => connection.destroy());
  connection.on("data", (chunk: string) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    buffered = "";
    connection.removeAllListeners("data");
    void respond(connection, line, options);
  });
}

async function respond(connection: net.Socket, line: string, options: InstanceLockOptions): Promise<void> {
  try {
    if ((JSON.parse(line) as { type?: unknown }).type !== "show") throw new Error("not a show request");
  } catch {
    connection.end();
    return;
  }
  try {
    await options.onShowWindows();
  } finally {
    connection.end(`${JSON.stringify({ pid: options.pid ?? process.pid, source: options.source })}\n`);
  }
}

function held(server: net.Server, endpoint: string, directory: string, platform: NodeJS.Platform): HeldInstanceLock {
  let released: Promise<void> | undefined;
  return {
    acquired: true,
    directory,
    release() {
      released ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.unref();
        if (platform !== "win32") fs.rmSync(endpoint, { force: true });
      });
      return released;
    },
  };
}

/** The running instance behind `endpoint`, or `undefined` when nothing answers its connection. */
function probe(endpoint: string): Promise<RunningInstance | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the running instance at ${endpoint} did not answer within ${PROBE_TIMEOUT_MS} ms`));
    }, PROBE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "show" })}\n`));
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") resolve(undefined);
      else reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(text) as { pid?: unknown; source?: unknown };
        if (typeof reply.pid !== "number" || typeof reply.source !== "string") throw new Error("malformed");
        resolve({ acquired: false, pid: reply.pid, source: reply.source });
      } catch {
        reject(new Error(`the running instance at ${endpoint} sent an answer that is not { pid, source }`));
      }
    });
  });
}

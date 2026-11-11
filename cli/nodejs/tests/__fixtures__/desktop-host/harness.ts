import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Shared by the desktop-host tests: a scratch user session, the built CLI, the fake helper and a raw HTTP client. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../../../bin/telo.mjs");
const FAKE = path.join(HERE, "..", "desktop-helper", "fake-desktop-helper.mjs");
const VERSION = (JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../package.json"), "utf8")) as { version: string }).version;
export const fixture = (name: string) => path.join(HERE, name);

let cache: string;
const children: ChildProcess[] = [];
const scratches: string[] = [];
const webviews: FakeWebview[] = [];
export const debugLogs: string[] = [];

export function useHarness(): void {
  beforeAll(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), "telo-dh-cache-"));
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    for (const webview of webviews.splice(0)) webview.close();
    for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const file of debugLogs.splice(0)) fs.rmSync(file, { force: true });
  });
  afterAll(() => fs.rmSync(cache, { recursive: true, force: true }));
}

export interface Scratch {
  dir: string;
  /** The environment of one user session: its own data and runtime directories. */
  env: Record<string, string>;
  /** The directory holding each application's per-user directory, as this platform lays it out. */
  dataRoot: string;
  log: string;
}

export function scratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-dh-"));
  scratches.push(dir);
  for (const sub of ["data", "rt", "home"]) fs.mkdirSync(path.join(dir, sub));
  const log = path.join(dir, "helper.jsonl");
  const dataRoot = process.platform === "darwin" ? path.join(dir, "home", "Library", "Application Support") : path.join(dir, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  return {
    dir,
    log,
    dataRoot,
    env: {
      DISPLAY: ":0",
      HOME: path.join(dir, "home"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_RUNTIME_DIR: path.join(dir, "rt"),
      TELO_HOST_DESKTOP_HELPER: FAKE,
      FAKE_HELPER_VERSION: VERSION,
      FAKE_HELPER_LOG: log,
      TELO_CACHE_DIR: cache,
    },
  };
}

export interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

export function telo(manifest: string, env: Record<string, string>, args: string[] = [], options: { noInput?: boolean } = {}): Run {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TELO_")));
  const child = spawn(process.execPath, [CLI, "run", ...(options.noInput === false ? [] : ["--no-input"]), ...args, manifest], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

export type Request = { id: number; type: string; payload: any };

export function requests(log: string): Request[] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Request);
}

export const ofType = (log: string, type: string) => requests(log).filter((request) => request.type === type);

export async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const opened = (log: string, window: string) =>
  until(`Window.Open of ${window}`, () => ofType(log, "Window.Open").find((r) => r.payload.window === window));

/** One request over a fresh connection; the whole answer as text. */
export function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk) => (answer += String(chunk)));
    socket.on("error", reject);
    socket.on("close", () => resolve(answer));
    socket.on("connect", () => socket.write(text));
  });
}

export const get = (target: string, headers: string[]) =>
  `GET ${target} HTTP/1.1\r\n${[...headers, "Connection: close"].map((h) => `${h}\r\n`).join("")}\r\n`;

/** One request the fake webview sent, and what answered it. */
export interface Hop {
  method: string;
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The local port of the connection it went on, and whether that connection was reused from the pool. */
  localPort: number;
  reused: boolean;
}

/**
 * What a webview's data store does to the connections and cookies of every window
 * in it: ONE keep-alive agent (one connection per origin) shared by all windows, a
 * cookie jar keyed by host — ports ignored, as browsers do — redirects followed,
 * and `Origin` sent on a form submission.
 */
export class FakeWebview {
  readonly hops: Hop[] = [];
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  private readonly jar = new Map<string, Map<string, string>>();

  constructor() {
    webviews.push(this);
  }

  /** Loads `url` as a window's navigation does, following redirects; every hop, in order. */
  async load(url: string): Promise<Hop[]> {
    return this.follow("GET", url, undefined, {});
  }

  /** Submits the page's first `<form>` as the document at `pageUrl` would: hidden fields, its `action`, `Origin`. */
  async submitForm(pageUrl: string, html: string): Promise<Hop[]> {
    const form = /<form method="post" action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/.exec(html);
    if (!form) throw new Error(`no form in ${html}`);
    const fields = [...form[2].matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map(([, name, value]) => [unescape(name), unescape(value)]);
    return this.submit(pageUrl, unescape(form[1]), new URLSearchParams(fields).toString());
  }

  /** A form submission from the document at `pageUrl` to `action`. */
  submit(pageUrl: string, action: string, body: string): Promise<Hop[]> {
    return this.follow("POST", new URL(action, pageUrl).href, body, {
      Origin: new URL(pageUrl).origin,
      "Content-Type": "application/x-www-form-urlencoded",
    });
  }

  /** The hops whose URL is on `origin`. */
  on(origin: string): Hop[] {
    return this.hops.filter((hop) => new URL(hop.url).origin === origin);
  }

  close(): void {
    this.agent.destroy();
  }

  private async follow(method: string, url: string, body: string | undefined, headers: Record<string, string>): Promise<Hop[]> {
    const chain: Hop[] = [];
    for (let hops = 0; hops < 10; hops++) {
      const hop = await this.send(method, url, body, headers);
      chain.push(hop);
      const location = hop.headers.location;
      if (![301, 302, 303, 307, 308].includes(hop.status) || !location) return chain;
      if (hop.status !== 307 && hop.status !== 308) {
        method = "GET";
        body = undefined;
        headers = {};
      }
      url = new URL(location, url).href;
    }
    throw new Error(`too many redirects from ${chain[0].url}`);
  }

  private send(method: string, url: string, body: string | undefined, extra: Record<string, string>): Promise<Hop> {
    const target = new URL(url);
    const cookies = [...(this.jar.get(target.hostname) ?? new Map())].map(([name, value]) => `${name}=${value}`).join("; ");
    return new Promise((resolve, reject) => {
      let localPort = 0;
      const request = http.request(
        {
          agent: this.agent,
          host: target.hostname,
          port: target.port,
          method,
          path: target.pathname + target.search,
          headers: {
            ...extra,
            ...(cookies ? { Cookie: cookies } : {}),
            ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            for (const line of response.headers["set-cookie"] ?? []) {
              const [pair] = line.split(";");
              const at = pair.indexOf("=");
              const cookies = this.jar.get(target.hostname) ?? new Map<string, string>();
              cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
              this.jar.set(target.hostname, cookies);
            }
            const hop: Hop = {
              method,
              url,
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: text,
              localPort,
              reused: request.reusedSocket,
            };
            this.hops.push(hop);
            resolve(hop);
          });
        },
      );
      request.on("socket", (socket) => {
        if (socket.localPort !== undefined) localPort = socket.localPort;
        else socket.once("connect", () => (localPort = socket.localPort!));
      });
      request.on("error", reject);
      request.end(body);
    });
  }
}

function unescape(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export const portOf = (url: string) => Number(new URL(url).port);

export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}


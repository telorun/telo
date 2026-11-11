import type { HostListeners } from "@telorun/kernel";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopAdmission, type AdmissionOptions } from "../src/desktop/desktop-admission.js";

/** Admission of the window's connections on the application's origin, before the kernel sees them. */

const SECRET = "admission-secret-of-this-launch";
const HOST_ORIGIN = "http://127.0.0.1:1";

let server: net.Server;
let port: number;
let admitted: Array<{ head: string; peer: string }>;

beforeEach(async () => {
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  admitted = [];
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A kernel listener that answers every connection it is handed with the bytes it received first. */
const listeners = {
  admit(_port: number, { socket, head, peer }: { socket: net.Socket; head?: Uint8Array; peer: string }) {
    admitted.push({ head: Buffer.from(head ?? []).toString("latin1"), peer });
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nserved");
  },
} as unknown as HostListeners;

function admission(options: Partial<AdmissionOptions> = {}): DesktopAdmission {
  return new DesktopAdmission(server, {
    port,
    origin: `http://127.0.0.1:${port}`,
    hostOrigin: HOST_ORIGIN,
    listeners,
    secret: SECRET,
    ...options,
  });
}

/** Writes `text` and resolves with everything the connection answered before it closed. */
function exchange(text: string | string[], pauseMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    socket.on("data", (chunk) => (answer += String(chunk)));
    socket.on("error", reject);
    socket.on("close", () => resolve(answer));
    socket.on("connect", async () => {
      for (const part of Array.isArray(text) ? text : [text]) {
        socket.write(part);
        if (pauseMs) await new Promise((wake) => setTimeout(wake, pauseMs));
      }
    });
  });
}

const get = (target: string, headers: string[] = [`Host: 127.0.0.1:${port}`]) =>
  `GET ${target} HTTP/1.1\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n`;
const withCookie = (extra: string[] = []) => [`Host: 127.0.0.1:${port}`, `Cookie: theme=dark; telo-window=${SECRET}`, ...extra];
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

describe("desktop admission", () => {
  it("hands a connection carrying the cookie to the kernel whole, the bytes it read included", async () => {
    admission();
    const first = get("/", withCookie());
    const pipelined = "GET /next HTTP/1.1\r\nHost: x\r\n\r\n";
    expect(await exchange([first.slice(0, 10), first.slice(10) + pipelined], 20)).toMatch(/served$/);
    expect(admitted).toHaveLength(1);
    expect(admitted[0].head).toBe(first + pipelined);
    expect(admitted[0].peer).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it.each([
    ["no cookie", get("/")],
    ["another cookie value", get("/", [`Host: 127.0.0.1:${port}`, "Cookie: telo-window=wrong"])],
    ["a forged Host", get("/", [`Host: localhost:${port}`, `Cookie: telo-window=${SECRET}`])],
    ["a second Host", get("/", [...withCookie(), "Host: 127.0.0.1:1"])],
    ["a forged Origin", get("/", withCookie(["Origin: http://evil.example"]))],
    ["an absolute-form target", get(`http://127.0.0.1/`, withCookie())],
    ["a line that is no header field", `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nnot a header\r\n\r\n`],
  ])("refuses %s with 403 and closes", async (_, request) => {
    admission();
    expect(await exchange(request)).toBe(FORBIDDEN);
    expect(admitted).toEqual([]);
  });

  it("admits the app's origin and the host origin as Origin, and reads no query parameter of its own", async () => {
    admission();
    expect(await exchange(get("/", withCookie([`Origin: http://127.0.0.1:${port}`])))).toMatch(/served$/);
    const fromHostPage = `POST /auth/callback HTTP/1.1\r\n${withCookie([`Origin: ${HOST_ORIGIN}`]).join("\r\n")}\r\nContent-Length: 0\r\n\r\n`;
    expect(await exchange(fromHostPage)).toMatch(/served$/);
    const target = "/?_telo.window=x&_telo.return=y";
    expect(await exchange(get(target, withCookie()))).toMatch(/served$/);
    expect(admitted.map((one) => one.head.split("\r\n")[0])).toEqual([
      "GET / HTTP/1.1",
      "POST /auth/callback HTTP/1.1",
      `GET ${target} HTTP/1.1`,
    ]);
  });

  it("refuses a head larger than its bound", async () => {
    admission({ maxHeadBytes: 64 });
    expect(await exchange(get("/", withCookie([`X-Fill: ${"a".repeat(200)}`])))).toBe(FORBIDDEN);
  });

  it("drops a connection that does not finish its head in time", async () => {
    admission({ headTimeoutMs: 100 });
    expect(await exchange(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`)).toBe("");
  });

  it("puts a request failing only the Origin rule, or carrying no cookie, to the unadmitted seam, and reads the body it asks for; a forged Host never reaches it", async () => {
    const seen: string[] = [];
    admission({
      unadmittedRequest: (request) => {
        seen.push(request.method);
        return { maxBytes: 8, onBody: (body) => ({ status: 200, reason: "OK", body: `got ${body.toString("utf8")}` }) };
      },
    });
    const post = (headers: string[]) => `POST /auth/callback HTTP/1.1\r\n${headers.join("\r\n")}\r\nContent-Length: 3\r\n\r\na=b`;
    expect(await exchange(post([`Host: 127.0.0.1:${port}`, "Origin: https://idp.example"]))).toMatch(/\r\n\r\ngot a=b$/);
    expect(await exchange(post(withCookie(["Origin: https://idp.example"])))).toMatch(/\r\n\r\ngot a=b$/);
    expect(await exchange(post([`Host: localhost:${port}`, "Origin: https://idp.example"]))).toBe(FORBIDDEN);
    expect(seen).toEqual(["POST", "POST"]);
    expect(admitted).toEqual([]);
  });
});

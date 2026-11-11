import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopHostOrigin, type HostOriginOptions } from "../src/desktop/desktop-host-origin.js";

/** The host origin: the loopback listener on which the host reads every request itself. */

const SECRET = "admission-secret-of-this-launch";
const APP = "http://127.0.0.1:5000";

let server: net.Server;
let port: number;

beforeEach(async () => {
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function hostOrigin(page: HostOriginOptions["page"] = () => undefined): DesktopHostOrigin {
  return new DesktopHostOrigin(server, { port, origin: `http://127.0.0.1:${port}`, secret: SECRET, page });
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
const withCookie = (extra: string[] = []) => [`Host: 127.0.0.1:${port}`, `Cookie: telo-window=${SECRET}`, ...extra];
const codeOf = (url: string) => new URL(url).searchParams.get("code")!;
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

describe("the host origin", () => {
  it("exchanges a window's code for the cookie with 303 to the destination bound to it, written absolute", async () => {
    const url = hostOrigin().admissionUrl("main", `${APP}//evil.com/a?b=1`);
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/admit\\?code=[\\w-]{24}$`));
    expect(await exchange(get(`/admit?code=${codeOf(url)}`))).toBe(
      "HTTP/1.1 303 See Other\r\n" +
        `Location: ${APP}//evil.com/a?b=1\r\n` +
        `Set-Cookie: telo-window=${SECRET}; HttpOnly; SameSite=Strict; Path=/\r\n` +
        "Referrer-Policy: no-referrer\r\n" +
        "Cache-Control: no-store\r\n" +
        "Content-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });

  it("refuses a code a second time, one it never issued, one of a closed window, and one not on a GET", async () => {
    const origin = hostOrigin();
    const used = codeOf(origin.admissionUrl("a", `${APP}/`));
    await exchange(get(`/admit?code=${used}`));
    const closed = codeOf(origin.admissionUrl("b", `${APP}/`));
    origin.windowClosed("b");
    const posted = codeOf(origin.admissionUrl("c", `${APP}/`));
    const twice = codeOf(origin.admissionUrl("d", `${APP}/`));
    for (const request of [
      get(`/admit?code=${used}`),
      get("/admit?code=guessed"),
      get(`/admit?code=${closed}`),
      `POST /admit?code=${posted} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\n\r\n`,
      get(`/admit?code=${twice}&code=${twice}`),
    ]) {
      expect(await exchange(request), request).toBe(FORBIDDEN);
    }
  });

  it.each([
    ["a forged Host", () => get("/startup", [`Host: localhost:${port}`, `Cookie: telo-window=${SECRET}`])],
    ["the app's Host", () => get("/startup", ["Host: 127.0.0.1:5000", `Cookie: telo-window=${SECRET}`])],
    ["a foreign Origin", () => get("/startup", withCookie(["Origin: http://evil.example"]))],
    ["the app's origin as Origin", () => get("/startup", withCookie([`Origin: ${APP}`]))],
    ["no cookie", () => get("/startup")],
    ["another cookie value", () => get("/startup", [`Host: 127.0.0.1:${port}`, "Cookie: telo-window=wrong"])],
    ["a path no page serves", () => get("/elsewhere", withCookie())],
  ])("refuses %s with 403", async (_, request) => {
    hostOrigin((r) => (r.path === "/startup" ? { status: 200, reason: "OK", body: "page" } : undefined));
    expect(await exchange(request())).toBe(FORBIDDEN);
  });

  it("serves a page to a request carrying the cookie, from its own origin, and closes the connection after it", async () => {
    hostOrigin((r) => (r.path === "/startup" ? { status: 200, reason: "OK", body: "page" } : undefined));
    const pipelined = get("/startup", withCookie([`Origin: http://127.0.0.1:${port}`])) + get("/startup", withCookie());
    expect(await exchange(pipelined)).toBe("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npage");
  });

  it("reads the body a page asks for, across packets, and refuses a missing or oversized length", async () => {
    hostOrigin(() => ({ maxBytes: 8, onBody: (body) => ({ status: 200, reason: "OK", body: `got ${body.toString("utf8")}` }) }));
    const post = (length: string | undefined, body: string) =>
      `POST /startup/answers HTTP/1.1\r\n${[...withCookie(), ...(length === undefined ? [] : [`Content-Length: ${length}`])].join("\r\n")}\r\n\r\n${body}`;
    expect(await exchange(post("5", "a=b&c"))).toMatch(/\r\n\r\ngot a=b&c$/);
    const head = post("5", "").split("\r\n\r\n")[0];
    expect(await exchange([`${head}\r\n\r\na=`, "b&c"], 30)).toMatch(/\r\n\r\ngot a=b&c$/);
    expect(await exchange(post(undefined, ""))).toMatch(/^HTTP\/1\.1 411 /);
    expect(await exchange(post("9", "123456789"))).toMatch(/^HTTP\/1\.1 413 /);
  });
});

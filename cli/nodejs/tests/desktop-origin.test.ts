import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bindOrigin, type OriginWarning } from "../src/desktop/desktop-origin.js";
import type { HeldInstanceLock } from "../src/desktop/single-instance-lock.js";

let directory: string;
let lock: HeldInstanceLock;
let open: net.Server[];
let warnings: OriginWarning[];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "telo-origin-"));
  lock = { acquired: true, directory, release: async () => {} };
  open = [];
  warnings = [];
});
afterEach(async () => {
  await Promise.all(open.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(directory, { recursive: true, force: true });
});

const portFile = () => path.join(directory, "port");
const bind = async (declaredPort?: number) => {
  const bound = await bindOrigin(lock, { declaredPort, warn: (w) => warnings.push(w) });
  open.push(bound.server);
  return bound;
};
const occupy = (port: number) =>
  new Promise<void>((resolve) => {
    const server = net.createServer();
    open.push(server);
    server.listen({ host: "127.0.0.1", port }, () => resolve());
  });
const closeServer = (server: net.Server) => new Promise((resolve) => server.close(resolve));

describe("the window's origin", () => {
  it("records an OS-assigned port on the first start and binds the same one on the next, silently", async () => {
    const first = await bind();
    expect(first.origin).toBe(`http://127.0.0.1:${first.port}`);
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(first.port));
    await closeServer(first.server);

    const second = await bind();
    expect(second.port).toBe(first.port);
    expect(warnings).toEqual([]);
  });

  it("records a new port and warns DESKTOP_ORIGIN_CHANGED when the recorded one is in use", async () => {
    const first = await bind();
    await closeServer(first.server);
    await occupy(first.port);

    const second = await bind();
    expect(second.port).not.toBe(first.port);
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(second.port));
    expect(warnings).toEqual([
      {
        code: "DESKTOP_ORIGIN_CHANGED",
        message:
          `${portFile()} named ${first.port}, which is in use; the window's origin is now ` +
          `http://127.0.0.1:${second.port} instead of http://127.0.0.1:${first.port}, ` +
          `so what the page kept in browser storage starts empty`,
      },
    ]);
  });

  it("warns, and records a new port, when the file holds no port", async () => {
    fs.writeFileSync(portFile(), "not a port\n");
    const bound = await bind();
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(bound.port));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("holds no port");
  });

  it("binds the declared default and leaves the port file alone", async () => {
    const free = await bind();
    await closeServer(free.server);
    fs.rmSync(portFile());

    const bound = await bind(free.port);
    expect(bound.port).toBe(free.port);
    expect(fs.existsSync(portFile())).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("falls back to a new port with the warning when the declared default is in use", async () => {
    const taken = await bind();
    const bound = await bind(taken.port);
    expect(bound.port).not.toBe(taken.port);
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(bound.port));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(`declares default ${taken.port}, which is in use`);
  });
});

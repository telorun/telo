import {
  NOOP_LOGGER,
  createCancellationSource,
  type CancellationSource,
  type InvokeContext,
  type NeedResolution,
} from "@telorun/sdk";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { create as createApi } from "../src/http-api-controller.js";
import { create as createServer } from "../src/http-server-controller.js";

/**
 * A mount's `hostnames` select it by the request's host: an exact host first,
 * then the pattern with the longest literal suffix, then the mounts with no
 * `hostnames`. Drives the real server controller over a socket, each address
 * need standing in as the resolution `ctx.resolveNeed` answers.
 */

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function expandWith(value: unknown, celCtx: Record<string, unknown>): unknown {
  if (typeof value === "function") return value(celCtx);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandWith(v, celCtx)]));
  }
  return value;
}

type Address = (
  | { url: string; port?: number; customDomains?: boolean }
  | { pattern: string; port?: number }
) & { name?: string };

function testContext(needs: Record<string, Address>, listenPort: number) {
  const inverses: Array<() => unknown> = [];
  const chain = (steps: Array<(input: unknown) => Promise<any>>): any => ({
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([...steps, body]),
    perform: async () => {
      let value: unknown;
      for (const step of steps) {
        const outcome = await step(value);
        if (outcome.inverse) inverses.push(outcome.inverse);
        value = outcome.result;
      }
      return { result: value, dispose: async () => {} };
    },
  });
  const resolveNeed = (pointer: string): NeedResolution => {
    const address = needs[pointer];
    if (!address) throw new Error(`no need at ${pointer}`);
    const port = address.port ?? listenPort;
    if ("pattern" in address) {
      return {
        target: { id: pointer, ref: { kind: "Telo.PublicUrl", name: address.name } } as never,
        fields: { pattern: address.pattern },
        sensitive: [],
        constraints: {},
        parameters: { port: "http" },
        port,
      };
    }
    return {
      target: { id: pointer, ref: { kind: "Telo.PublicUrl", name: address.name } } as never,
      fields: { url: { host: new URL(address.url).hostname } },
      sensitive: [],
      constraints: {},
      parameters: { port: "http", ...(address.customDomains ? { customDomains: true } : {}) },
      port,
    };
  };
  const ctx = {
    log: NOOP_LOGGER,
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([body]),
    acquireHold: () => () => {},
    emitEvent: async () => {},
    ensureKindRef: (value: { kind: string; name: string }) => value,
    moduleContext: { expandWith },
    validateSchema: () => {},
    readPlainEncoded: (value: unknown) => value,
    createCancellationSource: () => createCancellationSource(),
    rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
    openSpan: async (base: InvokeContext) => ({ context: base, settle: async () => {} }),
    invoke: async (_kind: string, name: string, inputs: unknown) => ({ who: name, inputs }),
    invokeResolved: async (_kind: string, name: string, _instance: unknown, inputs: unknown) => ({
      who: name,
      inputs,
    }),
    resolveNeed,
  };
  const unwind = async () => {
    for (const inverse of inverses.reverse()) await inverse();
  };
  return { ctx: ctx as never, unwind };
}

/** A router answering `GET <route>` (`/who` by default) with `{ who, host }` — `host` is `request.host`. */
async function router(name: string, ctx: never, route = "/who") {
  return createApi(
    {
      metadata: { name },
      routes: [
        {
          request: { path: route, method: "GET" },
          handler: { kind: "Test.Handler", name },
          inputs: { host: (c: { request: { host: string } }) => c.request.host },
          returns: [
            {
              status: 200,
              content: {
                "application/json": {
                  body: (c: { result: { who: string; inputs: { host: string } } }) => ({
                    who: c.result.who,
                    host: c.result.inputs.host,
                  }),
                },
              },
            },
          ],
        },
      ],
    } as never,
    ctx,
  );
}

async function start(
  mounts: Array<{ name: string; hostnames?: string[]; path?: string; route?: string }>,
  needs: Record<string, Address>,
  extra: Record<string, unknown> = {},
) {
  const port = await freePort();
  const harness = testContext(
    Object.fromEntries(
      mounts.flatMap((mount, i) =>
        (mount.hostnames ?? []).map((need, j) => [
          `/mounts/${i}/hostnames/${j}`,
          { ...needs[need]!, name: need },
        ]),
      ),
    ),
    port,
  );
  const built = [];
  for (const mount of mounts) {
    built.push({
      path: mount.path ?? "/",
      mount: await router(mount.name, harness.ctx, mount.route),
      ...(mount.hostnames ? { hostnames: mount.hostnames.map((name) => ({ kind: "Telo.PublicUrl", name })) } : {}),
    });
  }
  const server = await createServer(
    {
      kind: "Http.Server",
      metadata: { name: "web", module: "test" },
      listen: { address: "127.0.0.1", port },
      mounts: built,
      ...extra,
    } as never,
    harness.ctx,
  );
  await (server!.init!(harness.ctx as never) as any).perform();
  await (server!.run!(harness.ctx as never) as any).perform();
  return { ...harness, port };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}

let running: { unwind(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.unwind();
  running = undefined;
});

const NEEDS: Record<string, Address> = {
  site: { url: "http://shop.example" },
  admin: { url: "http://admin.shop.example" },
  tenants: { pattern: "http://*.shop.example" },
  prefixed: { pattern: "http://*-t.shop.example" },
};

describe("a mount's hostnames", () => {
  it("selects a mount by an exact host, then the longest pattern, then the unrestricted mounts", async () => {
    const server = await start(
      [
        { name: "open" },
        { name: "site", hostnames: ["site"] },
        { name: "admin", hostnames: ["admin"] },
        { name: "tenant", hostnames: ["tenants"] },
        { name: "prefixed", hostnames: ["prefixed"] },
      ],
      NEEDS,
    );
    running = server;
    const who = async (host: string) => (await get(server.port, "/who", { host })).body;
    expect(await who("shop.example")).toEqual({ who: "site", host: "shop.example" });
    expect(await who("Admin.Shop.Example:8443")).toEqual({ who: "admin", host: "admin.shop.example" });
    expect(await who("acme.shop.example")).toEqual({ who: "tenant", host: "acme.shop.example" });
    expect(await who("acme-t.shop.example")).toEqual({ who: "prefixed", host: "acme-t.shop.example" });
    expect(await who("elsewhere.example")).toEqual({ who: "open", host: "elsewhere.example" });
    expect(await who("127.0.0.1")).toEqual({ who: "open", host: "127.0.0.1" });
  });

  it("answers nothing for a host only restricted mounts register a route for", async () => {
    const server = await start([{ name: "site", hostnames: ["site"] }], NEEDS);
    running = server;
    expect((await get(server.port, "/who", { host: "elsewhere.example" })).status).toBe(404);
  });

  it("reads X-Forwarded-Host only behind a trusted proxy", async () => {
    const mounts = [{ name: "open" }, { name: "admin", hostnames: ["admin"] }];
    const headers = { host: "shop.example", "x-forwarded-host": "admin.shop.example" };
    const untrusted = await start(mounts, NEEDS);
    running = untrusted;
    expect((await get(untrusted.port, "/who", headers)).body.who).toBe("open");
    await untrusted.unwind();
    const trusted = await start(mounts, NEEDS, { trustProxy: true });
    running = trusted;
    expect((await get(trusted.port, "/who", headers)).body).toEqual({ who: "admin", host: "admin.shop.example" });
  });

  it("gives a mount taking custom domains every host no other mount claims", async () => {
    const server = await start(
      [
        { name: "admin", hostnames: ["admin"] },
        { name: "site", hostnames: ["site"] },
      ],
      { ...NEEDS, site: { url: "http://shop.example", customDomains: true } },
    );
    running = server;
    expect((await get(server.port, "/who", { host: "acme.com" })).body.who).toBe("site");
    expect((await get(server.port, "/who", { host: "admin.shop.example" })).body.who).toBe("admin");
  });

  it("refuses two mounts registering one route for one host", async () => {
    await expect(
      start(
        [
          { name: "a", hostnames: ["site"] },
          { name: "b", hostnames: ["site"] },
        ],
        NEEDS,
      ),
    ).rejects.toMatchObject({ code: "ERR_HTTP_ROUTE_DUPLICATE" });
  });

  it("tries a higher class before a more specific path in a lower one", async () => {
    const server = await start(
      [
        { name: "site", hostnames: ["site"], route: "/users/:id" },
        { name: "open", route: "/users/me" },
      ],
      NEEDS,
    );
    running = server;
    expect((await get(server.port, "/users/me", { host: "shop.example" })).body.who).toBe("site");
    expect((await get(server.port, "/users/me", { host: "elsewhere.example" })).body.who).toBe("open");
    expect((await get(server.port, "/users/42", { host: "elsewhere.example" })).status).toBe(404);
  });

  it("refuses an unrestricted mount and a custom-domains mount registering one route", async () => {
    await expect(
      start([{ name: "open" }, { name: "site", hostnames: ["site"] }], {
        site: { url: "http://shop.example", customDomains: true },
      }),
    ).rejects.toMatchObject({
      code: "ERR_HTTP_ROUTE_DUPLICATE",
      message: expect.stringMatching(/mounts\[0\].*mounts\[1\].*GET \/who/),
    });
  });

  it("refuses an address on a port the server does not listen on, naming the need", async () => {
    await expect(
      start([{ name: "site", hostnames: ["site"] }], { site: { url: "http://shop.example", port: 1 } }),
    ).rejects.toMatchObject({
      code: "ERR_HOSTNAMES_PORT_MISMATCH",
      message: expect.stringMatching(/need 'site'.*port 'http' \(1\).*listens on port \d+/),
    });
  });
});

describe("unknownHosts: reject", () => {
  it("answers a host no mount names 421, and an IP literal reaches the unrestricted mounts", async () => {
    const server = await start(
      [{ name: "open", path: "/health" }, { name: "site", hostnames: ["site"] }],
      NEEDS,
      { unknownHosts: "reject" },
    );
    running = server;
    const refused = await get(server.port, "/who", { host: "evil.example" });
    expect(refused.status).toBe(421);
    expect(refused.body.error.code).toBe("ERR_HOST_NOT_SERVED");
    expect((await get(server.port, "/health/who", { host: "127.0.0.1" })).body.who).toBe("open");
    expect((await get(server.port, "/health/who", { host: "[::1]" })).body.who).toBe("open");
    expect((await get(server.port, "/who", { host: "shop.example" })).body.who).toBe("site");
  });

  it("is refused with a mount taking custom domains", async () => {
    await expect(
      start([{ name: "site", hostnames: ["site"] }], { site: { url: "http://shop.example", customDomains: true } }, {
        unknownHosts: "reject",
      }),
    ).rejects.toMatchObject({ code: "ERR_HTTP_UNKNOWN_HOSTS_CUSTOM_DOMAINS" });
  });

  it("is refused at creation when no mount names hostnames", async () => {
    await expect(start([{ name: "open" }], NEEDS, { unknownHosts: "reject" })).rejects.toMatchObject({
      code: "ERR_HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES",
    });
  });
});

describe("the socket a server binds", () => {
  it("is refused at the top level, naming where it moved", async () => {
    await expect(
      createServer({ metadata: { name: "old" }, port: 8080, mounts: [] } as never, {} as never),
    ).rejects.toMatchObject({ code: "ERR_HTTP_SERVER_LISTEN_MOVED" });
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import { callerResolver, type CallerResolver } from "../session/session-credentials.js";
import {
  bootTestServer,
  FakeWorkloadBackend,
  settled,
  temporaryStore,
  TEST_SHARE_ROUTING,
  testConfig,
} from "../test-support/fake-workload-backend.js";
import { MemoryShareStore, withShares } from "../test-support/memory-share-store.js";

type Booted = Awaited<ReturnType<typeof bootTestServer>>;

const schemaPath = createRequire(import.meta.url).resolve("@telorun/runner-protocol/runner-protocol-schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(schema);
const routes = schema["x-telo-routes"] as Record<string, { responses: Record<string, string | null> }>;

/** The shape the protocol names for `route`'s answer with `status`, as errors. */
function problems(route: string, status: number, body: unknown): string[] {
  const named = routes[route]?.responses;
  const key = named && String(status) in named ? String(status) : "4xx";
  const shape = named && (key !== "4xx" || (status >= 400 && status < 500)) ? named[key] : undefined;
  if (shape === undefined) return [`${route} answered ${status}, which the protocol does not list`];
  if (shape === null) return body === "" || body === undefined ? [] : [`${route} ${status} must have no body`];
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${shape}`)!;
  return validate(body) ? [] : [JSON.stringify(validate.errors)];
}

const IDENTITY = { audience: "https://runner.example.com", issuers: ["https://id.example"] };

/** `Authorization: Test <sub>` is an identity; anything else is a resume secret. */
const sharesCaller: CallerResolver = (req) => {
  const test = /^Test (\S+)$/.exec(req.headers.authorization ?? "");
  if (!test) return callerResolver()(req);
  return Promise.resolve({
    caller: { kind: "owner", owner: { kind: "identity", iss: "https://id.example", sub: test[1]! } },
  });
};

/** A server offering shares, at most one per owner. */
async function bootWithShares(): Promise<Booted> {
  const handle = await temporaryStore();
  return bootTestServer(
    {
      backend: new FakeWorkloadBackend({ shareRouting: TEST_SHARE_ROUTING }),
      config: testConfig({
        identity: IDENTITY,
        shares: { ...testConfig().shares, enabled: true, maxPerOwner: 1 },
      }),
      resolveCaller: sharesCaller,
      store: withShares(handle.store, new MemoryShareStore()),
    },
    handle,
  );
}

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.server.app.close();
  await booted?.store.dispose();
  booted = undefined;
});

describe("the runner-protocol schema against runner-core's answers", () => {
  it("holds every route's responses and every event the stream carries", async () => {
    const b = (booted = await bootWithShares());
    const app = b.server.app;
    const failures: string[] = [];
    let auth: Record<string, string> = {};
    let sessionId = "";
    const call = async (
      method: "GET" | "POST" | "PUT" | "DELETE",
      route: string,
      url: string,
      payload?: object,
      headers: Record<string, string> = auth,
    ) => {
      const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      failures.push(...problems(route, res.statusCode, res.body === "" ? "" : res.json()));
      return res;
    };
    const apps = [{ name: "web", entryRelativePath: "web/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] }];

    await call("GET", "GET /v1/health", "/v1/health");
    await call("GET", "GET /v1/capabilities", "/v1/capabilities");
    await call("POST", "POST /v1/probe", "/v1/probe", { config: {} });

    const created = await call("POST", "POST /v1/sessions", "/v1/sessions", { workspace: "ws", apps });
    const { resumeSecret, sessionId: id } = created.json();
    sessionId = id;
    auth = { authorization: `Bearer ${resumeSecret}` };
    await expect.poll(() => b.server.registry.get(sessionId)?.status.kind).toBe("running");
    const s = `/v1/sessions/${sessionId}`;

    await call("POST", "POST /v1/sessions", "/v1/sessions", { workspace: "ws", apps });
    await call("GET", "GET /v1/sessions", "/v1/sessions");
    await call("GET", "GET /v1/sessions/{id}", s);
    await call("GET", "GET /v1/sessions/{id}", "/v1/sessions/nope");
    await call("PUT", "PUT /v1/sessions/{id}/apps", `${s}/apps`, { apps });
    await call("PUT", "PUT /v1/sessions/{id}/agent", `${s}/agent`, { name: null });
    await call("POST", "POST /v1/sessions/{id}/apps/{app}/run", `${s}/apps/web/run`, { env: {}, io: "tty" });
    await call("POST", "POST /v1/sessions/{id}/apps/{app}/stop", `${s}/apps/web/stop`);
    await call("POST", "POST /v1/sessions/{id}/io-tickets", `${s}/io-tickets`, { app: "web" });
    await call("GET", "GET /v1/sessions/{id}/workspace", `${s}/workspace`);
    await call("POST", "POST /v1/sessions/{id}/workspace", `${s}/workspace`, {
      write: [{ path: "a.yaml", content: "x" }],
    });
    await call("GET", "GET /v1/sessions/{id}/workspace/file", `${s}/workspace/file?path=a.yaml`);
    await call("POST", "POST /v1/sessions/{id}/reload", `${s}/reload`);
    await call("POST", "POST /v1/sessions/{id}/suspend", `${s}/suspend`);
    await call("POST", "POST /v1/sessions/{id}/resume", `${s}/resume`);
    await settled();

    const eventShape = ajv.getSchema(`${schema.$id}#/$defs/RunEvent`)!;
    const events = b.server.registry.get(sessionId)!.buffer.replay(0).entries.map((e) => e.event);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      if (!eventShape(event)) failures.push(`${JSON.stringify(event)}: ${JSON.stringify(eventShape.errors)}`);
    }

    await call("DELETE", "DELETE /v1/sessions/{id}", s);

    const alice = { authorization: "Test alice" };
    const share = { name: "demo", application: "WebhookDemo" };
    const made = await call("POST", "POST /v1/shares", "/v1/shares", share, alice);
    await call("POST", "POST /v1/shares", "/v1/shares", share, alice);
    await call("POST", "POST /v1/shares", "/v1/shares", { ...share, name: "second" }, alice);
    await call("POST", "POST /v1/shares", "/v1/shares", share, { authorization: `Bearer ${resumeSecret}` });
    await call("GET", "GET /v1/shares", "/v1/shares", undefined, alice);
    await call("DELETE", "DELETE /v1/shares/{id}", `/v1/shares/${made.json().id}`, undefined, alice);
    await call("DELETE", "DELETE /v1/shares/{id}", `/v1/shares/${made.json().id}`, undefined, alice);
    expect(failures).toEqual([]);
  });

  it("serves every session route the protocol lists", async () => {
    const b = (booted = await bootWithShares());
    const unserved = Object.keys(routes).filter((key) => {
      const [method, url] = key.split(" ") as [string, string];
      const served = /^\/v1\/sessions\/\{id\}\/owner|well-known/.test(url) || key.includes("/events");
      return !served && !b.server.app.hasRoute({ method: method as "GET", url: url.replace(/\{(\w+)\}/g, ":$1") });
    });
    expect(unserved).toEqual([]);
  });

  it("refuses an answer carrying a field the schema lacks", async () => {
    const b = (booted = await bootTestServer());
    const health = (await b.server.app.inject({ url: "/v1/health" })).json();
    expect(problems("GET /v1/health", 200, health)).toEqual([]);
    expect(problems("GET /v1/health", 200, { ...health, extra: 1 })).not.toEqual([]);
  });
});

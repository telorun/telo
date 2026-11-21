import { singleLanguageTranslations } from "./single-language-translations.js";
import {
  NOOP_LOGGER,
  createCancellationSource,
  type CancellationSource,
  type InvokeContext,
} from "@telorun/sdk";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { create as createApi } from "../src/http-api-controller.js";
import { create as createReference } from "../src/http-reference-controller.js";
import { create as createServer } from "../src/http-server-controller.js";

/**
 * The generated OpenAPI documents are 3.2.0 and validate against the official
 * 3.2 schema, pinned in `__fixtures__/openapi-3.2-schema-2025-09-17.json` —
 * fetched from https://spec.openapis.org/oas/3.2/schema/2025-09-17 (sha256
 * 0c9d74bf25f9b9388b2d81e421ef60fdefa9feffa94898dadfc501b342b3bfcc).
 */

// The file's one `#meta` anchor is the Schema Object stub, which the official
// dialect schema overrides; Ajv's dynamic scope does not resolve it, so each
// `$dynamicRef` reads as the plain reference to that anchor's definition.
const schema = JSON.parse(
  readFileSync(new URL("./__fixtures__/openapi-3.2-schema-2025-09-17.json", import.meta.url), "utf8").replaceAll(
    '"$dynamicRef": "#meta"',
    '"$ref": "#/$defs/schema"',
  ),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function context(hosts: Record<string, string>, listenPort: number) {
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
  const ctx = {
    translations: singleLanguageTranslations,
    log: NOOP_LOGGER,
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([body]),
    acquireHold: () => () => {},
    claimListener: async () => null,
    emitEvent: async () => {},
    setStatus: async () => {},
    readPlainEncoded: (value: unknown) => value,
    ensureKindRef: (value: { kind: string; name: string }) => value,
    moduleContext: { expandWith: (value: unknown) => value },
    validateSchema: () => {},
    createCancellationSource: () => createCancellationSource(),
    rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
    openSpan: async (base: InvokeContext) => ({ context: base, settle: async () => {} }),
    invoke: async () => ({}),
    invokeResolved: async () => ({}),
    resolveControllerFile: async () => pathToFileURL(new URL("./__fixtures__/openapi-3.2-schema-2025-09-17.json", import.meta.url).pathname).href,
    resolveNeed: (pointer: string) => ({
      target: { id: pointer, ref: { kind: "Telo.PublicUrl", name: pointer } } as never,
      fields: { url: { host: hosts[pointer] } },
      sensitive: [],
      constraints: {},
      parameters: { port: "http" },
      port: listenPort,
    }),
    declaredDisplayMessage: () => undefined,
  };
  return { ctx: ctx as never, unwind: async () => { for (const inverse of inverses.reverse()) await inverse(); } };
}

const returns = [
  { status: 200, content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } }, body: { ok: true } } } },
];
const routes = {
  query: { request: { path: "/report", method: "QUERY", schema: { body: { type: "object", required: ["from"], properties: { from: { type: "string" } } } } }, returns },
  get: { request: { path: "/ping", method: "GET" }, returns },
};

async function start(mounts: Array<{ name: string; route: keyof typeof routes; host?: string }>) {
  const port = await freePort();
  const harness = context(
    Object.fromEntries(mounts.flatMap((m, i) => (m.host ? [[`/mounts/${i}/hostnames/0`, m.host]] : []))),
    port,
  );
  const built: unknown[] = [];
  for (const [i, m] of mounts.entries()) {
    built.push({
      path: "/",
      mount: await createApi({ metadata: { name: m.name }, routes: [routes[m.route]] } as never, harness.ctx),
      ...(m.host ? { hostnames: [{ kind: "Telo.PublicUrl", name: `n${i}` }] } : {}),
    });
  }
  const reference = await createReference({ metadata: { name: "docs" } } as never, harness.ctx);
  await (reference as any).init();
  built.push({ path: "/docs", mount: reference });
  const server = await createServer(
    {
      kind: "Http.Server",
      metadata: { name: "web", module: "test" },
      listen: { address: "127.0.0.1", port },
      trustProxy: true,
      openapi: { info: { title: "Doc", version: "1.0.0" } },
      mounts: built,
    } as never,
    harness.ctx,
  );
  await (server!.init!(harness.ctx as never) as any).perform();
  await (server!.run!(harness.ctx as never) as any).perform();
  return { ...harness, port };
}

function document(port: number, host: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/docs/openapi.json", headers: { "x-forwarded-host": host } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(JSON.parse(text)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function expectValid(doc: unknown) {
  expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
}

let running: { unwind(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.unwind();
  running = undefined;
});

describe("the generated OpenAPI document", () => {
  it("is 3.2.0 and lists a QUERY route under `query` with its request body", async () => {
    running = await start([{ name: "api", route: "query" }]);
    const doc = await document((running as any).port, "any.example");
    expectValid(doc);
    expect(doc.openapi).toBe("3.2.0");
    expect(doc.paths["/report"].query.requestBody.content["application/json"].schema.required).toEqual(["from"]);
  });

  it("is 3.2.0 and valid for a server with no QUERY route", async () => {
    running = await start([{ name: "api", route: "get" }]);
    const doc = await document((running as any).port, "any.example");
    expectValid(doc);
    expect(doc.openapi).toBe("3.2.0");
  });

  it("is valid per host, and lists `query` only for the host reaching the QUERY route", async () => {
    running = await start([
      { name: "site", route: "get", host: "shop.example" },
      { name: "admin", route: "query", host: "admin.example" },
    ]);
    const port = (running as any).port;
    const site = await document(port, "shop.example");
    const admin = await document(port, "admin.example");
    expectValid(site);
    expectValid(admin);
    expect(Object.keys(site.paths)).toEqual(["/ping"]);
    expect(Object.keys(admin.paths["/report"])).toEqual(["query"]);
  });
});

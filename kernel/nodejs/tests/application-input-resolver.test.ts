import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";
import {
  unresolvedInputsOf,
  type ApplicationInputResolver,
  type UnresolvedApplicationInput,
} from "../src/unresolved-inputs.js";

const silent = { write: () => true } as unknown as NodeJS.WritableStream;

const types = `kind: Telo.Library
metadata:
  name: Db
exports:
  kinds: [Access]
---
kind: Telo.NeedType
metadata:
  name: Access
fields:
  url: { type: string, pattern: "^postgres://", x-telo-sensitive: true }
  pool: { type: integer }
required: [url]
`;

const app = `kind: Telo.Application
metadata:
  name: Asked
imports:
  Db: memory://types
variables:
  clientId: { env: CLIENT_ID, type: string, description: The OAuth client id }
  logLevel: { env: LOG_LEVEL, type: string, default: info }
  retries: { env: RETRIES, type: integer, arg: retries }
secrets:
  token: { env: API_TOKEN, type: string }
ports:
  http: { env: PORT }
needs:
  database:
    kind: Db.Access
    env: { url: DATABASE_URL }
  cache:
    kind: Db.Access
    optional: true
`;

const ASKED = ["variables.clientId", "variables.retries", "secrets.token", "ports.http", "needs database.url"];

function kernelFor(manifest: string, env: Record<string, string> = {}): Kernel {
  const memory = new MemorySource();
  memory.set("app", manifest);
  memory.set("types", types);
  return new Kernel({ sources: [memory], env, stderr: silent });
}

async function refusalOf(load: Promise<void>): Promise<Error & { code?: string }> {
  try {
    await load;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the load to be refused");
}

/** A resolver answering from `answers`, recording every batch it is handed. */
function answering(answers: Record<string, string | readonly string[]>) {
  const asked: UnresolvedApplicationInput[][] = [];
  const turns = new Map<string, number>();
  const resolver: ApplicationInputResolver = async (unresolved) => {
    asked.push([...unresolved]);
    const given = new Map<string, string>();
    for (const input of unresolved) {
      const answer = answers[input.id];
      if (answer === undefined) continue;
      const turn = turns.get(input.id) ?? 0;
      turns.set(input.id, turn + 1);
      given.set(input.id, typeof answer === "string" ? answer : answer[Math.min(turn, answer.length - 1)]!);
    }
    return given;
  };
  return { resolver, asked };
}

const rootOf = (kernel: Kernel) => (kernel as unknown as { rootContext: ModuleContext }).rootContext;

describe("asking the host for missing inputs", () => {
  it("asks for exactly the entries the refusal names when nothing is asked", async () => {
    const refused = await refusalOf(kernelFor(app).load("memory://app"));
    expect(refused.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(unresolvedInputsOf(refused)?.map((input) => input.id)).toEqual(ASKED);

    const { resolver, asked } = answering({});
    const declined = await refusalOf(kernelFor(app).load("memory://app", { inputResolver: resolver }));
    expect(asked.map((batch) => batch.map((input) => input.id))).toEqual([ASKED]);
    expect(declined.message).toBe(refused.message);
    expect(unresolvedInputsOf(declined)).toEqual(unresolvedInputsOf(refused));
  });

  it("describes each entry as --help does, marking secrets and sensitive need fields", async () => {
    const refused = await refusalOf(kernelFor(app).load("memory://app"));
    const byId = new Map(unresolvedInputsOf(refused)!.map((input) => [input.id, input]));
    expect(byId.get("variables.clientId")).toMatchObject({
      env: "CLIENT_ID",
      type: "string",
      sensitive: false,
      description: "The OAuth client id",
    });
    expect(byId.get("variables.retries")).toMatchObject({ env: "RETRIES", arg: "--retries", type: "integer" });
    expect(byId.get("secrets.token")).toMatchObject({ env: "API_TOKEN", sensitive: true });
    expect(byId.get("ports.http")).toMatchObject({ env: "PORT", type: "tcp port" });
    expect(byId.get("needs database.url")).toMatchObject({
      env: "DATABASE_URL",
      sensitive: true,
      schema: { pattern: "^postgres://" },
    });
  });

  it("starts on the answers, delivering a need field's answer only through the need", async () => {
    const { resolver } = answering({
      "variables.clientId": "abc",
      "variables.retries": "3",
      "secrets.token": "t0ken",
      "ports.http": "8080",
      "needs database.url": "postgres://db/main",
    });
    const kernel = kernelFor(app);
    await kernel.load("memory://app", { inputResolver: resolver });
    await kernel.boot();
    const root = rootOf(kernel);
    expect(root.variables).toEqual({ clientId: "abc", logLevel: "info", retries: 3n });
    expect(root.secrets).toEqual({ token: "t0ken" });
    expect(root.ports).toEqual({ http: 8080 });
    expect(root.resources.database).toEqual({ url: "postgres://db/main" });
    expect(root.resources.cache).toBeNull();

    const ctx = (kernel as unknown as {
      createResourceContext(m: ModuleContext, r: unknown): { env: Record<string, string | undefined> };
    }).createResourceContext(root, { kind: "Test.Probe", metadata: { name: "probe" } });
    expect([kernel.env.DATABASE_URL, ctx.env.DATABASE_URL, process.env.DATABASE_URL]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(Object.values(kernel.env)).not.toContain("t0ken");
    await kernel.teardown();
  });

  it("never asks while any value is invalid, nor when --help is asked for", async () => {
    for (const [env, argv] of [
      [{ RETRIES: "many" }, []],
      [{}, ["--retries", "x", "--help"]],
    ] as const) {
      const memory = new MemorySource();
      memory.set("app", app);
      memory.set("types", types);
      const kernel = new Kernel({ sources: [memory], env: { ...env }, argv: [...argv], stderr: silent });
      const { resolver, asked } = answering({});
      await kernel.load("memory://app", { inputResolver: resolver }).catch((error: unknown) => {
        expect(unresolvedInputsOf(error)).toBeUndefined();
      });
      expect(asked).toEqual([]);
    }
  });

  it("asks a partly supplied need only for its missing required fields, keeping the need's code", async () => {
    const env = { CLIENT_ID: "a", RETRIES: "1", API_TOKEN: "t", PORT: "80", TELO_NEED_DATABASE__POOL: "4" };
    const refused = await refusalOf(kernelFor(app, env).load("memory://app"));
    expect(refused.code).toBe("ERR_NEED_PARTIALLY_SUPPLIED");
    expect(unresolvedInputsOf(refused)?.map((input) => input.id)).toEqual(["needs database.url"]);

    const { resolver } = answering({ "needs database.url": "postgres://db/main" });
    const kernel = kernelFor(app, env);
    await kernel.load("memory://app", { inputResolver: resolver });
    expect(rootOf(kernel).resources.database).toEqual({ url: "postgres://db/main", pool: 4 });
  });

  it("asks a refused answer again with the kernel's sentence, never quoting a sensitive one", async () => {
    const env = { CLIENT_ID: "a", RETRIES: "1", API_TOKEN: "t" };
    const { resolver, asked } = answering({
      "ports.http": ["eighty", "80"],
      "needs database.url": ["mysql://root:hunter2@db", "postgres://db/main"],
    });
    await kernelFor(app, env).load("memory://app", { inputResolver: resolver });
    expect(asked.map((batch) => batch.map((input) => [input.id, input.refusal]))).toEqual([
      [
        ["ports.http", undefined],
        ["needs database.url", undefined],
      ],
      [
        ["ports.http", 'http: the answer: value "eighty" is not a valid integer'],
        ["needs database.url", expect.stringContaining("needs database.url: the answer: ")],
      ],
    ]);
    expect(JSON.stringify(asked)).not.toContain("hunter2");
  });

  it("holds a template-derived public URL back until its port is answered, then derives it", async () => {
    const manifest = `kind: Telo.Application
metadata:
  name: Shop
ports:
  http: { env: PORT }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http }
`;
    const env = { TELO_HOST_PUBLIC_URL_TEMPLATE: "https://{port}-s1.example.dev" };
    const { resolver, asked } = answering({ "ports.http": "8080" });
    const kernel = kernelFor(manifest, env);
    await kernel.load("memory://app", { inputResolver: resolver });
    expect(asked.map((batch) => batch.map((input) => input.id))).toEqual([["ports.http"]]);
    expect(kernel.addresses.map((address) => address.host)).toEqual(["8080-s1.example.dev"]);
  });
});

describe("an answer is read as the environment's text", () => {
  const manifest = `kind: Telo.Application
metadata:
  name: Coerced
variables:
  text: { env: V_TEXT, type: string }
  count: { env: V_COUNT, type: integer }
  ratio: { env: V_RATIO, type: number }
  on: { env: V_ON, type: boolean }
  shape: { env: V_SHAPE, type: object }
  list: { env: V_LIST, type: array, items: { type: integer } }
  opens: { env: V_OPENS, type: string, x-telo-type: Telo.Timestamp }
  wait: { env: V_WAIT, type: string, x-telo-type: Telo.Duration }
  dir: { env: V_DIR, type: string, x-telo-type: Telo.HostPath }
  empty: { env: V_EMPTY, type: string }
`;
  const text: Record<string, string> = {
    text: "hello world",
    count: "42",
    ratio: "0.5",
    on: "true",
    shape: '{"a":[1,2]}',
    list: "[1,2,3]",
    opens: "2026-01-02T03:04:05Z",
    wait: "1h30m",
    dir: "relative/dir",
    empty: "",
  };

  it("decodes every type to what the same text in the environment decodes to", async () => {
    const fromEnv = kernelFor(
      manifest,
      Object.fromEntries(Object.entries(text).map(([name, value]) => [`V_${name.toUpperCase()}`, value])),
    );
    await fromEnv.load("memory://app");

    const { resolver } = answering(
      Object.fromEntries(Object.entries(text).map(([name, value]) => [`variables.${name}`, value])),
    );
    const fromAnswers = kernelFor(manifest);
    await fromAnswers.load("memory://app", { inputResolver: resolver });

    expect(rootOf(fromAnswers).variables).toEqual(rootOf(fromEnv).variables);
    expect(rootOf(fromAnswers).variables.dir).toBe(path.resolve("relative/dir"));
  });
});

import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";
import { NeedFulfilment } from "../src/need-fulfilment.js";
import { ResourceContextImpl } from "../src/resource-context.js";

class Capture {
  readonly chunks: string[] = [];
  get records(): Record<string, unknown>[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
}

const KEY = "s3cret-signing-key";

const types = `kind: Telo.Library
metadata:
  name: Keys
exports:
  kinds: [SigningKey]
---
kind: Telo.NeedType
metadata:
  name: SigningKey
fields:
  value: { type: string, x-telo-sensitive: true }
  label: { type: string }
required: [value]
`;

const sessions = `kind: Telo.Library
metadata:
  name: Sessions
imports:
  Keys: memory://types
needs:
  signingKey:
    kind: Keys.SigningKey
`;

const app = `kind: Telo.Application
metadata:
  name: NeedsApp
imports:
  Sessions:
    source: memory://sessions
    needs:
      signingKey:
        value: ${KEY}
        label: visible-label
logging:
  sinks:
    - kind: Telo.ConsoleSink
      encoding: json
`;

describe("a sensitive need field", () => {
  it("joins the redaction set of the importer that owns the fulfilment and of the library bound to it", async () => {
    const memory = new MemorySource();
    memory.set("app", app);
    memory.set("sessions", sessions);
    memory.set("types", types);
    const stderr = new Capture();
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: stderr.stream });
    await kernel.load("memory://app");
    await kernel.boot();

    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const library = root.children.find(
      (child) => (child as ModuleContext).getLoggingConfig?.()?.scope === "Sessions",
    ) as ModuleContext;
    expect(library).toBeDefined();
    kernel.logging
      .createLogger(library.getLoggingConfig(), undefined)
      .info("in the library", { key: KEY, label: "visible-label" });
    kernel.logging.kernelLogger().info("in the importer", { key: KEY });
    await kernel.teardown();

    const attributesOf = (msg: string) =>
      stderr.records.find((record) => record["msg"] === msg)?.["attributes"];
    expect(attributesOf("in the library")).toEqual({ key: "[redacted]", label: "visible-label" });
    expect(attributesOf("in the importer")).toEqual({ key: "[redacted]" });
    expect(stderr.chunks.join("")).not.toContain(KEY);
  });
});

describe("ResourceContext.resolveRef on a need", () => {
  const fulfilment = new NeedFulfilment("Keys.SigningKey", { value: KEY }, [KEY]);
  const moduleContext = {
    resourceInstances: new Map([
      ["signingKey", { instance: fulfilment, resource: { kind: "Keys.SigningKey", metadata: { name: "signingKey" } } }],
    ]),
    getInstance: (name: string) => (name === "signingKey" ? fulfilment : undefined),
    resolveImportedInstance: () => undefined,
  };
  const ctx = new ResourceContextImpl(
    { resourceKindByName: () => "Keys.SigningKey" } as never,
    moduleContext as never,
    { name: "consumer" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "",
    moduleContext as never,
  );
  // A guard the fulfilment would satisfy, so only the refusal can stop it.
  const hasSnapshot = (value: unknown): value is { snapshot(): unknown } =>
    typeof (value as { snapshot?: unknown } | undefined)?.snapshot === "function";

  it("refuses a reference naming a fulfilment, and one injected as the instance", () => {
    for (const value of [{ kind: "Keys.SigningKey", name: "signingKey" }, fulfilment]) {
      expect(() => ctx.resolveRef(value, hasSnapshot, () => "Test.Consumer 'key'")).toThrow(
        expect.objectContaining({ code: "ERR_REF_UNRESOLVED" }),
      );
    }
  });
});

describe("a need read from the environment", () => {
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
  const app = (extra = "") => `kind: Telo.Application
metadata:
  name: EnvNeeds
imports:
  Db: memory://types
variables:
  port: { env: PORT, type: integer }
needs:
  database:
    kind: Db.Access
    env: { url: DATABASE_URL }
${extra}`;
  const load = async (env: Record<string, string>) => {
    const memory = new MemorySource();
    memory.set("app", app());
    memory.set("types", types);
    const kernel = new Kernel({ sources: [memory], env, stderr: new Capture().stream });
    await kernel.load("memory://app");
    return kernel;
  };

  it("is refused as partly supplied when a field is set and a required one is not", async () => {
    await expect(load({ PORT: "8080", TELO_NEED_DATABASE__POOL: "4" })).rejects.toMatchObject({
      code: "ERR_NEED_PARTIALLY_SUPPLIED",
      message: expect.stringContaining(
        "TELO_NEED_DATABASE__POOL is set, and the required DATABASE_URL is not",
      ),
    });
  });

  it("joins a value that does not decode to the application's validation failure, never printing a sensitive one", async () => {
    const secret = "mysql://root:hunter2@db";
    const failure = load({ PORT: "eighty", DATABASE_URL: secret, TELO_NEED_DATABASE__POOL: "many" });
    await expect(failure).rejects.toMatchObject({ code: "ERR_MANIFEST_VALIDATION_FAILED" });
    const message = ((await failure.catch((e) => e)) as Error).message;
    expect(message).toContain("port: environment variable PORT");
    expect(message).toContain("needs database.url: environment variable DATABASE_URL");
    expect(message).toContain('needs database.pool: environment variable TELO_NEED_DATABASE__POOL: value "many" is not a valid integer');
    expect(message).not.toContain("hunter2");
  });

  it("is hidden by name from process.env and from ctx.env", async () => {
    const env = { PORT: "8080", DATABASE_URL: "postgres://db/main", TELO_NEED_DATABASE__POOL: "4", OTHER: "kept" };
    process.env.DATABASE_URL = env.DATABASE_URL;
    process.env.TELO_NEED_DATABASE__POOL = env.TELO_NEED_DATABASE__POOL;
    const kernel = await load(env);
    await kernel.boot();
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const ctx = (kernel as unknown as {
      createResourceContext(m: ModuleContext, r: unknown): { env: Record<string, string | undefined> };
    }).createResourceContext(root, { kind: "Test.Probe", metadata: { name: "probe" } });
    expect([ctx.env.DATABASE_URL, ctx.env.TELO_NEED_DATABASE__POOL, ctx.env.OTHER]).toEqual([
      undefined,
      undefined,
      "kept",
    ]);
    expect([process.env.DATABASE_URL, process.env.TELO_NEED_DATABASE__POOL]).toEqual([
      undefined,
      undefined,
    ]);
    await kernel.teardown();
  });
});

describe("a load the need table refuses", () => {
  it("raises the table's twins together with every other error the analysis found", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: MixedRefusals
needs:
  thing:
    kind: Self.Missing
---
kind: Self.AlsoMissing
metadata:
  name: other
`,
    );
    const kernel = new Kernel({ sources: [memory], env: {}, stderr: new Capture().stream });
    const failure = (await kernel.load("memory://app").catch((e) => e)) as {
      code: string;
      diagnostics: Array<{ code?: string }>;
    };
    expect(failure.code).toBe("ERR_NEED_TYPE_UNRESOLVED");
    expect(failure.diagnostics.map((d) => d.code)).toEqual([
      "ERR_NEED_TYPE_UNRESOLVED",
      "UNDEFINED_KIND",
    ]);
  });
});

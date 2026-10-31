import { demandingEvery } from "./input-demand.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";
import { NeedFulfilment } from "../src/need-fulfilment.js";
import { ResourceContextImpl } from "../src/resource-context.js";
import { resolveApplicationEnv } from "../src/application-env.js";
import { SchemaValidator } from "../src/schema-validator.js";

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

describe("a root need supplied by name", () => {
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
  url: { type: string, x-telo-sensitive: true }
  pool: { type: integer }
required: [url]
supply: root
`;
  const app = `kind: Telo.Application
metadata:
  name: SuppliedNeeds
imports:
  Db: memory://types
needs:
  database:
    kind: Db.Access
    env: { url: DATABASE_URL }
  state:
    kind: Telo.DurableDirectory
`;
  const load = async (needs: Record<string, Record<string, unknown>>, env: Record<string, string> = {}) => {
    const memory = new MemorySource();
    memory.set("app", app);
    memory.set("types", types);
    const kernel = new Kernel({
      sources: [memory],
      env,
      stderr: new Capture().stream,
      inputs: { needs, suppliedBy: "App.Instance 'worker'" },
    });
    await kernel.load("memory://app");
    return kernel;
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-supplied-needs-"));
  const state = { path: path.join(scratch, "state") };
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("wins over the environment and the host values, for a type only a root may supply", async () => {
    const kernel = await load(
      { database: { url: "postgres://supplied/main" }, state },
      {
        DATABASE_URL: "postgres://from-env/main",
        TELO_HOST_STATE_DIR: path.join(scratch, "host"),
      },
    );
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const fieldsOf = (name: string) =>
      (root.resourceInstances.get(name)?.instance as NeedFulfilment | undefined)?.fields;
    expect([fieldsOf("database"), fieldsOf("state")]).toEqual([{ url: "postgres://supplied/main" }, state]);
    expect(fs.existsSync(path.join(scratch, "host"))).toBe(false);
  });

  it("refuses a name the application does not declare, naming the needs it does", async () => {
    await expect(load({ database: { url: "postgres://db" }, state, cache: {} })).rejects.toMatchObject({
      code: "ERR_MANIFEST_VALIDATION_FAILED",
      message: expect.stringContaining(
        "cache: this application declares no `needs` entry by that name (it declares: database, state)",
      ),
    });
  });

  it("refuses a supply missing a required field as partly supplied", async () => {
    await expect(load({ database: { pool: 4 }, state })).rejects.toMatchObject({
      code: "ERR_NEED_PARTIALLY_SUPPLIED",
      message: expect.stringContaining(
        "supplied by name by App.Instance 'worker' only in part: pool is given, and the required url is not",
      ),
    });
  });

  it("refuses an unusable directory, naming who supplied it", async () => {
    const file = path.join(scratch, "a-file");
    fs.writeFileSync(file, "");
    await expect(load({ database: { url: "postgres://db" }, state: { path: file } })).rejects.toMatchObject({
      code: "ERR_NEED_DIRECTORY_UNUSABLE",
      message: expect.stringContaining("from the value supplied by name by App.Instance 'worker'"),
    });
  });
});

describe("a Telo.Url read from the environment", () => {
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
  url:
    x-telo-type: { name: Telo.Url, scheme: { enum: [postgres, postgresql] } }
required: [url]
`;
  const app = `kind: Telo.Application
metadata:
  name: EnvUrls
imports:
  Db: memory://types
variables:
  replica:
    env: REPLICA_URL
    type: string
    x-telo-type: Telo.Url
needs:
  database:
    kind: Db.Access
    env: { url: DATABASE_URL }
`;
  const load = async (env: Record<string, string>) => {
    const memory = new MemorySource();
    memory.set("app", app);
    memory.set("types", types);
    const kernel = new Kernel({ sources: [memory], env, stderr: new Capture().stream });
    await kernel.load("memory://app");
    return kernel;
  };

  it("joins a value that does not read, or that the slot's scheme refuses, to the application's validation failure as ERR_URL_INVALID, naming the variable and never the value", async () => {
    const failure = load({ DATABASE_URL: "mysql://root:hunter2@db/app", REPLICA_URL: "postgres://root:s3cret@db/app#top" });
    await expect(failure).rejects.toMatchObject({ code: "ERR_MANIFEST_VALIDATION_FAILED" });
    const message = ((await failure.catch((e) => e)) as Error).message;
    expect(message).toContain(
      "needs database.url: environment variable DATABASE_URL: ERR_URL_INVALID: not a Telo.Url — its scheme must be one of postgres, postgresql",
    );
    expect(message).toContain(
      "replica: environment variable REPLICA_URL: ERR_URL_INVALID: not a Telo.Url — it holds a fragment ('#')",
    );
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("s3cret");
  });

  it("refuses a default the slot's scheme refuses the same way", () => {
    const refusal = (() => {
      try {
        resolveApplicationEnv(
          {
            metadata: { name: "DefaultUrl" },
            variables: {
              databaseUrl: {
                env: "DATABASE_URL",
                type: "string",
                "x-telo-type": { name: "Telo.Url", scheme: { enum: ["postgres", "postgresql"] } },
                default: "mysql://root:hunter2@db/app",
              },
            },
          },
          {},
          new SchemaValidator(), demandingEvery(),
        );
      } catch (error) {
        return error as { code: string; message: string };
      }
    })();
    expect(refusal?.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(refusal?.message).toContain(
      "databaseUrl: ERR_URL_INVALID: not a Telo.Url — its scheme must be one of postgres, postgresql",
    );
    expect(refusal?.message).not.toContain("hunter2");
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

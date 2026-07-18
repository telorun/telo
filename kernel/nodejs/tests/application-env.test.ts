import { effectiveAuthorSchema } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  precompileDefinitionSchemas,
  resolveApplicationEnv,
} from "../src/application-env.js";
import { SchemaValidator } from "../src/schema-validator.js";

function buildValidator(): SchemaValidator {
  return new SchemaValidator();
}

describe("precompileDefinitionSchemas", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-defwarm-"));
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  const defSchema = {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  };

  it("bakes a standalone validator for each Telo.Definition schema", async () => {
    const v = buildValidator();
    v.setCacheDir(cacheDir);
    precompileDefinitionSchemas(
      [{ kind: "Telo.Definition", metadata: { name: "Thing" }, schema: defSchema }],
      v,
    );
    const baked = await fs.readdir(cacheDir);
    expect(baked.filter((f) => f.endsWith(".cjs")).length).toBe(1);
  });

  it("warm-compiled validators are hash-stable across a fresh validator (runtime hits the cache)", async () => {
    // Warm with one validator instance, then a brand-new instance pointed at the
    // same cache must reuse the baked file — i.e. write nothing new. Mirrors the
    // build (`telo install`) → runtime (`telo run`) handoff across processes.
    const warm = buildValidator();
    warm.setCacheDir(cacheDir);
    precompileDefinitionSchemas([{ kind: "Telo.Definition", schema: defSchema }], warm);
    const afterWarm = (await fs.readdir(cacheDir)).sort();

    const runtime = buildValidator();
    runtime.setCacheDir(cacheDir);
    runtime.compile(defSchema).validate({ url: "x" });
    const afterRuntime = (await fs.readdir(cacheDir)).sort();
    expect(afterRuntime).toEqual(afterWarm);
  });

  // An `extends` child without `base:` is validated at runtime against
  // merge(parent, own) — a different object, so a different cache key than its
  // raw `schema:`. The warm must bake that merged form or every inheriting kind
  // misses on every boot and, on a read-only image, can never persist.
  describe("extends-resolved schemas", () => {
    const parent = {
      kind: "Telo.Definition",
      metadata: { name: "Model", module: "embedding" },
      schema: {
        type: "object",
        properties: { queryPrompt: { type: "string" } },
      },
    };
    const child = {
      kind: "Telo.Definition",
      metadata: { name: "Model", module: "embedding-openai" },
      extends: "embedding.Model",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { model: { type: "string" } },
      },
    };
    const resolve = (kind: string) =>
      kind === "embedding.Model" ? (parent as never) : undefined;

    it("bakes the merged schema so the runtime hits the cache", async () => {
      const warm = buildValidator();
      warm.setCacheDir(cacheDir);
      precompileDefinitionSchemas([parent, child], warm, () => resolve);
      const afterWarm = (await fs.readdir(cacheDir)).sort();

      // What the runtime stamps and validates against.
      const merged = effectiveAuthorSchema(child as never, resolve);
      const runtime = buildValidator();
      runtime.setCacheDir(cacheDir);
      runtime.compile(merged).validate({ model: "m", queryPrompt: "q: {text}" });

      expect((await fs.readdir(cacheDir)).sort()).toEqual(afterWarm);
    });

    it("bakes the merged form in addition to the raw one, not instead of it", async () => {
      const warm = buildValidator();
      warm.setCacheDir(cacheDir);
      precompileDefinitionSchemas([parent, child], warm, () => resolve);
      const baked = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".cjs"));
      // parent schema + child raw schema + child merged schema
      expect(baked.length).toBe(3);
    });

    it("without a resolver, bakes only the raw schema (the merged form then misses)", async () => {
      const warm = buildValidator();
      warm.setCacheDir(cacheDir);
      precompileDefinitionSchemas([parent, child], warm);
      const afterWarm = (await fs.readdir(cacheDir)).sort();

      const runtime = buildValidator();
      runtime.setCacheDir(cacheDir);
      runtime.compile(effectiveAuthorSchema(child as never, resolve));

      // Documents the pre-fix behaviour this opt-in exists to close.
      expect((await fs.readdir(cacheDir)).length).toBeGreaterThan(afterWarm.length);
    });

    // The resolver is a FACTORY because `extends` aliases are lexically scoped
    // to the declaring module — `Cache.Store` reads against that library's
    // imports, `Self.Host` against its own name. Resolving them through one
    // global scope silently yields the un-merged schema, which is the exact
    // miss this whole mechanism exists to prevent (it put `CacheMemory.Store`
    // and `Shell.LocalHost` back on the runtime-write path).
    it("resolves each definition's extends in that definition's own module scope", async () => {
      const selfChild = {
        kind: "Telo.Definition",
        metadata: { name: "LocalHost", module: "shell" },
        extends: "Self.Host",
        schema: { type: "object", properties: { cwd: { type: "string" } } },
      };
      const selfParent = {
        kind: "Telo.Definition",
        metadata: { name: "Host", module: "shell" },
        schema: { type: "object", properties: { shell: { type: "string" } } },
      };
      // Only a shell-scoped resolver knows `Self` — a global one returns nothing.
      const scoped = (def: Record<string, any>) => (kind: string) =>
        def.metadata?.module === "shell" && kind === "Self.Host"
          ? (selfParent as never)
          : undefined;

      const warm = buildValidator();
      warm.setCacheDir(cacheDir);
      precompileDefinitionSchemas([selfParent, selfChild], warm, scoped);
      const afterWarm = (await fs.readdir(cacheDir)).sort();

      const runtime = buildValidator();
      runtime.setCacheDir(cacheDir);
      runtime.compile(effectiveAuthorSchema(selfChild as never, scoped(selfChild)));

      expect((await fs.readdir(cacheDir)).sort()).toEqual(afterWarm);
    });

    it("an unresolvable parent is skipped, not thrown", () => {
      const warm = buildValidator();
      warm.setCacheDir(cacheDir);
      expect(() =>
        precompileDefinitionSchemas([child], warm, () => () => undefined),
      ).not.toThrow();
    });
  });

  it("converges a parse-time tagged sentinel with the runtime compiled value of the same source", () => {
    // Build-time warm sees `{__tagged, engine, source}`; runtime sees
    // `{__compiled, source}`. Same `source` → one validator identity.
    const v = buildValidator();
    const tagged = {
      ...defSchema,
      examples: [{ url: { __tagged: true, engine: "cel", source: "req.id" } }],
    };
    const compiled = {
      ...defSchema,
      examples: [{ url: { __compiled: true, source: "req.id" } }],
    };
    expect(v.compile(tagged)).toBe(v.compile(compiled));
  });

  it("converges an inline-template string with its compiled form (same source)", () => {
    const v = buildValidator();
    const inline = { ...defSchema, description: "hi ${{ x }}" };
    const compiledInline = {
      ...defSchema,
      description: { __compiled: true, source: "hi ${{ x }}" },
    };
    expect(v.compile(inline)).toBe(v.compile(compiledInline));
  });

  it("does NOT collide schemas that differ by a property literally named 'description'", () => {
    // Regression guard: the cache key must not drop keys by name — `description`
    // here is a validated field, not an annotation keyword.
    const v = buildValidator();
    const withDesc = {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" } },
      additionalProperties: false,
    };
    const withoutDesc = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    expect(v.compile(withDesc)).not.toBe(v.compile(withoutDesc));
    expect(v.compile(withDesc).isValid({ name: "x", description: "y" })).toBe(true);
    expect(v.compile(withoutDesc).isValid({ name: "x", description: "y" })).toBe(false);
  });
});

describe("resolveApplicationEnv", () => {
  it("populates variables and secrets from env", () => {
    const result = resolveApplicationEnv(
      {
        variables: {
          port: { env: "PORT", type: "integer", minimum: 1024 },
          logLevel: {
            env: "LOG_LEVEL",
            type: "string",
            enum: ["debug", "info", "warn", "error"],
          },
        },
        secrets: {
          databaseUrl: { env: "DATABASE_URL", type: "string" },
        },
      },
      { PORT: "1234", LOG_LEVEL: "info", DATABASE_URL: "postgres://x" },
      buildValidator(),
    );
    expect(result.variables).toEqual({ port: 1234, logLevel: "info" });
    expect(result.secrets).toEqual({ databaseUrl: "postgres://x" });
  });

  it("applies default when env var is unset", () => {
    const result = resolveApplicationEnv(
      {
        variables: {
          port: { env: "PORT", type: "integer", default: 3000 },
        },
      },
      {},
      buildValidator(),
    );
    expect(result.variables).toEqual({ port: 3000 });
  });

  it("aggregates errors for missing required env vars", () => {
    let thrown: unknown;
    try {
      resolveApplicationEnv(
        {
          variables: {
            port: { env: "PORT", type: "integer" },
            host: { env: "HOST", type: "string" },
          },
        },
        {},
        buildValidator(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RuntimeError);
    expect((thrown as RuntimeError).code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect((thrown as Error).message).toContain(
      "port: environment variable PORT is not set",
    );
    expect((thrown as Error).message).toContain(
      "host: environment variable HOST is not set",
    );
  });

  it("rejects non-integer env value for integer type", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            port: { env: "PORT", type: "integer" },
          },
        },
        { PORT: "abc" },
        buildValidator(),
      ),
    ).toThrow(/value "abc" is not a valid integer/);
  });

  it("rejects boolean env values that aren't 'true' or 'false'", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            on: { env: "ON", type: "boolean" },
          },
        },
        { ON: "yes" },
        buildValidator(),
      ),
    ).toThrow(/is not a valid boolean/);
  });

  it("rejects coerced value that violates the residual schema", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            port: { env: "PORT", type: "integer", minimum: 1024 },
          },
        },
        { PORT: "80" },
        buildValidator(),
      ),
    ).toThrow(/port:/);
  });

  it("parses object env values from JSON", () => {
    const result = resolveApplicationEnv(
      {
        variables: {
          tls: {
            env: "TLS",
            type: "object",
            properties: { cert: { type: "string" }, key: { type: "string" } },
            required: ["cert", "key"],
          },
        },
      },
      { TLS: '{"cert":"a","key":"b"}' },
      buildValidator(),
    );
    expect(result.variables).toEqual({ tls: { cert: "a", key: "b" } });
  });

  it("parses array env values from JSON", () => {
    const result = resolveApplicationEnv(
      {
        variables: {
          origins: {
            env: "ORIGINS",
            type: "array",
            items: { type: "string" },
          },
        },
      },
      { ORIGINS: '["x","y"]' },
      buildValidator(),
    );
    expect(result.variables).toEqual({ origins: ["x", "y"] });
  });

  it("rejects JSON value with wrong top-level type for type:object", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            tls: { env: "TLS", type: "object" },
          },
        },
        { TLS: "[]" },
        buildValidator(),
      ),
    ).toThrow(/expected JSON object, got array/);
  });

  it("rejects JSON value with wrong top-level type for type:array", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            origins: { env: "ORIGINS", type: "array" },
          },
        },
        { ORIGINS: '{"a":1}' },
        buildValidator(),
      ),
    ).toThrow(/expected JSON array, got object/);
  });

  it("rejects unparseable JSON for object/array types", () => {
    expect(() =>
      resolveApplicationEnv(
        {
          variables: {
            tls: { env: "TLS", type: "object" },
          },
        },
        { TLS: "not-json" },
        buildValidator(),
      ),
    ).toThrow(/value is not valid JSON/);
  });

  describe("secret redaction in error messages", () => {
    it("redacts secret raw values in integer coercion errors", () => {
      try {
        resolveApplicationEnv(
          {
            secrets: {
              port: { env: "SECRET_PORT", type: "integer" },
            },
          },
          { SECRET_PORT: "sk-live-abc123" },
          buildValidator(),
        );
        throw new Error("expected to throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("SECRET_PORT");
        expect(msg).toContain("<redacted>");
        expect(msg).not.toContain("sk-live-abc123");
      }
    });

    it("redacts secret raw values in boolean coercion errors", () => {
      try {
        resolveApplicationEnv(
          {
            secrets: {
              flag: { env: "SECRET_FLAG", type: "boolean" },
            },
          },
          { SECRET_FLAG: "super-secret" },
          buildValidator(),
        );
        throw new Error("expected to throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("SECRET_FLAG");
        expect(msg).toContain("<redacted>");
        expect(msg).not.toContain("super-secret");
      }
    });

    it("redacts the JSON parser's detail message for secret JSON entries", () => {
      try {
        resolveApplicationEnv(
          {
            secrets: {
              tls: { env: "SECRET_TLS", type: "object" },
            },
          },
          { SECRET_TLS: "not-json-cert-xyz" },
          buildValidator(),
        );
        throw new Error("expected to throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("SECRET_TLS");
        expect(msg).toContain("value is not valid JSON");
        expect(msg).not.toContain("not-json-cert-xyz");
      }
    });

    it("redacts the coerced value in residual-schema validation errors", () => {
      try {
        resolveApplicationEnv(
          {
            secrets: {
              token: {
                env: "SECRET_TOKEN",
                type: "string",
                pattern: "^prod-",
              },
            },
          },
          { SECRET_TOKEN: "stg-leaky-token-value" },
          buildValidator(),
        );
        throw new Error("expected to throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("token:");
        expect(msg).not.toContain("stg-leaky-token-value");
      }
    });

    it("keeps raw values for non-secret entries", () => {
      try {
        resolveApplicationEnv(
          {
            variables: {
              port: { env: "PORT", type: "integer" },
            },
          },
          { PORT: "abc" },
          buildValidator(),
        );
        throw new Error("expected to throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("\"abc\"");
        expect(msg).not.toContain("<redacted>");
      }
    });
  });

  describe("ports", () => {
    it("resolves ports from env as integers", () => {
      const result = resolveApplicationEnv(
        {
          ports: {
            http: { env: "PORT", protocol: "tcp" },
            dns: { env: "DNS_PORT", protocol: "udp" },
          },
        },
        { PORT: "8080", DNS_PORT: "5353" },
        buildValidator(),
      );
      expect(result.ports).toEqual({ http: 8080, dns: 5353 });
    });

    it("applies the port default when the env var is unset", () => {
      const result = resolveApplicationEnv(
        { ports: { http: { env: "PORT", default: 3000 } } },
        {},
        buildValidator(),
      );
      expect(result.ports).toEqual({ http: 3000 });
    });

    it("errors when a port env var is unset and has no default", () => {
      let thrown: unknown;
      try {
        resolveApplicationEnv(
          { ports: { http: { env: "PORT" } } },
          {},
          buildValidator(),
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RuntimeError);
      expect((thrown as RuntimeError).code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
      expect((thrown as Error).message).toContain(
        "http: environment variable PORT is not set",
      );
    });

    it("rejects a port outside the 1–65535 range", () => {
      let thrown: unknown;
      try {
        resolveApplicationEnv(
          { ports: { http: { env: "PORT" } } },
          { PORT: "70000" },
          buildValidator(),
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RuntimeError);
      expect((thrown as Error).message).toContain("http:");
    });

    it("rejects a non-integer port value", () => {
      expect(() =>
        resolveApplicationEnv(
          { ports: { http: { env: "PORT" } } },
          { PORT: "abc" },
          buildValidator(),
        ),
      ).toThrow(RuntimeError);
    });
  });
});

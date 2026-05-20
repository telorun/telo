import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { resolveApplicationEnv } from "../src/application-env.js";
import { SchemaValidator } from "../src/schema-validator.js";

function buildValidator(): SchemaValidator {
  return new SchemaValidator();
}

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
});

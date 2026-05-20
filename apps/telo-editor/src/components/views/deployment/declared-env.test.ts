import { describe, expect, it } from "vitest";
import { extractDeclaredEnvEntries } from "./declared-env";

describe("extractDeclaredEnvEntries", () => {
  it("returns variables and secrets rows for an Application", () => {
    const rows = extractDeclaredEnvEntries({
      kind: "Application",
      metadata: {
        variables: {
          port: { env: "PORT", type: "integer", minimum: 1024, default: 3000 },
          logLevel: {
            env: "LOG_LEVEL",
            type: "string",
            enum: ["debug", "info", "warn", "error"],
            default: "info",
          },
        },
        secrets: {
          databaseUrl: { env: "DATABASE_URL", type: "string" },
        },
      },
    });
    expect(rows).toEqual([
      {
        name: "port",
        envVar: "PORT",
        type: "integer",
        secret: false,
        defaultText: "3000",
        constraints: "≥ 1024",
      },
      {
        name: "logLevel",
        envVar: "LOG_LEVEL",
        type: "string",
        secret: false,
        defaultText: "info",
        constraints: "enum: debug, info, warn, error",
      },
      {
        name: "databaseUrl",
        envVar: "DATABASE_URL",
        type: "string",
        secret: true,
        defaultText: undefined,
        constraints: undefined,
      },
    ]);
  });

  it("returns an empty list for Library manifests", () => {
    const rows = extractDeclaredEnvEntries({
      kind: "Library",
      metadata: {
        variables: {
          port: { type: "integer", minimum: 1024 },
        },
      },
    });
    expect(rows).toEqual([]);
  });

  it("skips entries with no env: mapping", () => {
    const rows = extractDeclaredEnvEntries({
      kind: "Application",
      metadata: {
        variables: {
          legacy: { type: "string" },
          ok: { env: "OK", type: "string" },
        },
      },
    });
    expect(rows.map((r) => r.name)).toEqual(["ok"]);
  });

  it("summarises object and array constraints", () => {
    const rows = extractDeclaredEnvEntries({
      kind: "Application",
      metadata: {
        variables: {
          tls: {
            env: "TLS",
            type: "object",
            properties: { cert: { type: "string" }, key: { type: "string" } },
            required: ["cert", "key"],
          },
          origins: {
            env: "ORIGINS",
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
      },
    });
    expect(rows[0]?.constraints).toContain("object{cert, key}");
    expect(rows[1]?.constraints).toContain("array of string");
    expect(rows[1]?.constraints).toContain("min items 1");
  });
});

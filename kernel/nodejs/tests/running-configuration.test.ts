import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const APP_YAML = `kind: Telo.Application
metadata:
  name: RunningConfiguration
variables:
  level:
    env: LEVEL
    type: string
    enum: [low, high]
    default: low
--- !switch
metadata: { name: Shape }
switch: !cel "variables.level"
cases:
  low:
    kind: Telo.JsonSchema
    schema: { type: string }
  high:
    kind: Telo.JsonSchema
    schema: { type: integer }
`;

function makeKernel(env: Record<string, string>): Kernel {
  const memory = new MemorySource();
  memory.set("app", APP_YAML);
  return new Kernel({ sources: [memory], env });
}

describe("the configuration a load starts in", () => {
  it("refuses a dimension's value outside its domain, naming the input and its values, before any resource exists", async () => {
    const kernel = makeKernel({ LEVEL: "medium" });
    const created: string[] = [];
    kernel.on("*", (event) => {
      if (String(event.name).endsWith(".Created")) created.push(String(event.name));
    });
    let error: { code?: string; message?: string } | undefined;
    try {
      await kernel.load("memory://app", { cacheDir: null });
    } catch (e) {
      error = e as { code?: string; message?: string };
    }
    expect(error?.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(error?.message).toContain("level:");
    expect(error?.message).toContain("low | high");
    expect(created).toEqual([]);
  });

  it("creates only the chosen branch, and reports the configuration as the process starts", async () => {
    const kernel = makeKernel({ LEVEL: "high" });
    const shapes: unknown[] = [];
    kernel.on("*", (event) => {
      if (event.name === "Telo.JsonSchema.Shape.Created") shapes.push(event.payload.properties);
    });
    let starting: unknown;
    kernel.on("Kernel.Starting", (event) => {
      starting = event.payload;
    });
    await kernel.load("memory://app", { cacheDir: null });
    await kernel.boot();
    await kernel.runTargets();
    expect(starting).toMatchObject({ configuration: { "variables.level": "high" } });
    expect(shapes).toEqual([{ schema: { type: "integer" } }]);
    await kernel.teardown();
  });

  it("refuses a URL whose scheme its declaration does not allow, naming the secret and never its value", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: UrlDimension
secrets:
  databaseUrl:
    env: DATABASE_URL
    type: string
    x-telo-type: { name: Telo.Url, scheme: { enum: [postgres, sqlite] } }
--- !switch
metadata: { name: Shape }
switch: !cel "secrets.databaseUrl.scheme"
cases:
  postgres: { kind: Telo.JsonSchema, schema: { type: string } }
  sqlite: { kind: Telo.JsonSchema, schema: { type: integer } }
`,
    );
    const kernel = new Kernel({ sources: [memory], env: { DATABASE_URL: "mysql://app:hunter2@db/orders" } });
    let error: { code?: string; message?: string } | undefined;
    try {
      await kernel.load("memory://app", { cacheDir: null });
    } catch (e) {
      error = e as { code?: string; message?: string };
    }
    expect(error?.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(error?.message).toContain("databaseUrl:");
    expect(error?.message).toContain("ERR_URL_INVALID");
    expect(error?.message).not.toContain("hunter2");
  });
});

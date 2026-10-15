import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { compareObservation } from "../src/need-resolution.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/__fixtures__/needs/consume/run",
);

/** Every error beneath `error`, its diagnostics' and children's included. */
function flatten(error: unknown): Array<{ code?: string; message: string; data?: unknown }> {
  const out: Array<{ code?: string; message: string; data?: unknown }> = [];
  const visit = (node: any) => {
    if (!node) return;
    out.push({ code: node.code, message: String(node.message ?? ""), data: node.data });
    for (const child of node.diagnostics ?? node.children ?? []) visit(child);
  };
  visit(error);
  return out;
}

describe("a consumer's observation, compared by the kernel", () => {
  it("refuses a version outside the outermost need's range with ERR_NEED_UNMET naming the environment name it was read from", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: { DATABASE_URL: "postgres://db.internal/orders" } });
    await kernel.load(path.join(FIXTURES, "env-outside.yaml"));
    const failure = await kernel.boot().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    const unmet = flatten(failure).find((e) => e.message.includes("ERR_NEED_UNMET") || e.code === "ERR_NEED_UNMET");
    expect(unmet?.message).toContain(
      "Need 'databaseAccess' (type 'ConsumeKinds.DatabaseAccess') is not met: the fulfilment supplied from the environment (DATABASE_URL) has version 16.3.0, outside '>=17.0.0'.",
    );
  });

  it("carries need, type, source, required and actual in the refusal's data", () => {
    const outermost = {
      path: ["databaseAccess"],
      declaredBy: "app",
      moduleName: "App",
      need: {
        name: "databaseAccess",
        kind: "Kinds.DatabaseAccess",
        type: "Kinds.DatabaseAccess",
        version: ">=15.0.0",
        features: ["pgvector"],
        optional: false,
        declaresEnv: true,
      },
      supply: "environment" as const,
      fields: {
        url: { env: "DATABASE_URL", envSource: "bound" as const, required: true, sensitive: true },
      },
    };
    let refusal: unknown;
    try {
      compareObservation(outermost, "Kinds.DatabaseAccess", ["pgvector", "postgis"], {
        version: "14.11.0",
        features: ["postgis"],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "ERR_NEED_UNMET",
      data: {
        need: "databaseAccess",
        type: "Kinds.DatabaseAccess",
        source: "env",
        required: { version: ">=15.0.0", features: ["pgvector"] },
        actual: { version: "14.11.0", features: ["postgis"] },
      },
    });
  });
});

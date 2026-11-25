/**
 * The contract refusal vectors, as the Node kernel answers them: each row's value is
 * passed through a contract bound to the row's schema in its direction — a call's
 * inputs, or a result — and the refusal's code, message and `data` are compared whole.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTypedFrame, isInvokeError } from "@telorun/sdk";
import {
  bindContract,
  resolveBoundContract,
  type ContractValidatorFactory,
} from "../src/invocation-contract-binding.js";
import { SchemaValidator } from "../src/schema-validator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.resolve(HERE, "../../contract-refusal-conformance/vectors.json");
const ROWS = 7;

interface Row {
  id: string;
  direction: "inputType" | "outputType";
  schema: Record<string, unknown>;
  value: unknown;
  expect: { code: string; message: string; data: unknown };
}

const vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8")) as { target: string; rows: Row[] };

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if ("$telo" in value) return decodeTypedFrame(JSON.stringify(value));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function factory(): ContractValidatorFactory {
  const validator = new SchemaValidator();
  return Object.assign((schema: unknown) => validator.compile(schema), {
    schemaOf: (typeRef: unknown) => typeRef as Record<string, any>,
    resolveRef: () => undefined,
    withRules: (name: string | undefined, schema: Record<string, any>) => validator.compile(schema),
    accepts: (schema: Record<string, any>, value: unknown) => validator.compile(schema).isValid(value),
  }) as ContractValidatorFactory;
}

async function refusalOf(row: Row): Promise<unknown> {
  const value = decode(row.value);
  const manifest = { kind: "Fx.Probe", metadata: { name: "probe" }, [row.direction]: row.schema };
  const contract = resolveBoundContract(row.direction, manifest as any, undefined, () => undefined, factory());
  const instance = { invoke: async (inputs: unknown) => (row.direction === "outputType" ? value : inputs) };
  bindContract(instance as any, {
    [row.direction === "inputType" ? "input" : "output"]: contract,
    describeTarget: () => vectors.target,
  });
  try {
    await instance.invoke(row.direction === "inputType" ? value : {});
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("contract refusal conformance", () => {
  it("answers every row", () => {
    expect(vectors.rows).toHaveLength(ROWS);
    for (const row of vectors.rows) {
      expect(Object.keys(row).sort(), row.id).toEqual(["direction", "expect", "id", "schema", "value"]);
    }
  });

  it.each(vectors.rows.map((row) => [row.id, row] as const))("%s", async (id, row) => {
    const error = await refusalOf(row);
    expect(isInvokeError(error), id).toBe(true);
    const refused = error as { code: string; message: string; data?: unknown };
    expect({ code: refused.code, message: refused.message, data: refused.data ?? null }).toEqual(row.expect);
  });
});

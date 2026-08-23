import { describe, expect, it } from "vitest";
import AjvModule from "ajv";
import { formatAjvErrors as analyzerFormat, registerTeloKeywords } from "@telorun/analyzer";
import { formatAjvErrors as kernelFormat } from "../src/manifest-schemas.js";
import { acceptReportedStatus } from "../src/observed-state.js";

/** Agreement is the property being bought: a developer who fixes what `telo
 *  check` told them must not meet a different sentence describing the same
 *  failure at runtime. One fixture, both halves. */
const SCHEMA = {
  type: "object",
  properties: {
    content: {
      anyOf: [
        { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        { type: "object", required: ["table"], properties: { table: { type: "object" } } },
      ],
    },
  },
};

function errorsFor(value: unknown): any[] {
  const Ajv = (AjvModule as any).default ?? AjvModule;
  const ajv = new Ajv({ allErrors: true, strict: false });
  registerTeloKeywords(ajv);
  const validate = ajv.compile(SCHEMA);
  expect(validate(value)).toBe(false);
  return validate.errors ?? [];
}

describe("one schema-error renderer", () => {
  it("the kernel and the analyzer phrase the same failure identically", () => {
    const errors = errorsFor({ content: { text: 42 } });
    expect(kernelFormat(errors)).toBe(analyzerFormat(errors));
    expect(kernelFormat(errors)).toContain("/content/text must be string");
  });

  it("observed state reports through the same renderer, unions reduced", () => {
    expect(() =>
      acceptReportedStatus(
        { content: { text: 42 } },
        { kind: "Test.Kind", name: "probe", statusSchema: SCHEMA },
      ),
    ).toThrow(/\/content\/text must be string/);
    expect(() =>
      acceptReportedStatus(
        { content: { text: 42 } },
        { kind: "Test.Kind", name: "probe", statusSchema: SCHEMA },
      ),
    ).not.toThrow(/'table'/);
  });
});

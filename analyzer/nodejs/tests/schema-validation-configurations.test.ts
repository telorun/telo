import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { createAjv, SCHEMA_VALIDATION_CONFIGURATIONS } from "../src/schema-validation.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const TWO_ERRORS = { type: "object", required: ["a", "b"] };
const DEFAULTED = { type: "object", properties: { a: { type: "integer", default: 1 } } };
const CLOSED = { type: "object", additionalProperties: false, properties: { kept: { type: "string" } } };
const LIVE = { "x-telo-type": { name: "Telo.Stream", of: { type: "string" } } };

/** What one validation under `configuration` reports and leaves in the value. */
function run(configuration: (typeof SCHEMA_VALIDATION_CONFIGURATIONS)[number], schema: object, value: unknown) {
  const validate = createAjv(configuration).compile(schema);
  const valid = validate(value);
  return { valid, errors: validate.errors ?? [], value };
}

describe("the schema validation configurations", () => {
  it("analysis reports every error, fills nothing and asserts a live type", () => {
    expect(run("analysis", TWO_ERRORS, {}).errors).toHaveLength(2);
    expect(run("analysis", DEFAULTED, {}).value).toEqual({});
    expect(run("analysis", LIVE, {}).valid).toBe(false);
  });

  it("analysis-verbose names the schema node of each error", () => {
    const { errors } = run("analysis-verbose", TWO_ERRORS, {});
    expect(errors).toHaveLength(2);
    expect(errors[0]!.parentSchema).toEqual(TWO_ERRORS);
  });

  it("analysis-defaults fills defaults and reports every error", () => {
    expect(run("analysis-defaults", DEFAULTED, {}).value).toEqual({ a: 1 });
    expect(run("analysis-defaults", TWO_ERRORS, {}).errors).toHaveLength(2);
  });

  it("primary stops at the first error, fills defaults and exempts a live type", () => {
    expect(run("primary", TWO_ERRORS, {}).errors).toHaveLength(1);
    expect(run("primary", DEFAULTED, {}).value).toEqual({ a: 1 });
    expect(run("primary", LIVE, {}).valid).toBe(true);
    expect((createAjv("primary").opts.code as { source?: boolean }).source).toBe(true);
  });

  it("filling fills defaults and reports every error", () => {
    expect(run("filling", TWO_ERRORS, {}).errors).toHaveLength(2);
    expect(run("filling", DEFAULTED, {}).value).toEqual({ a: 1 });
  });

  it("locating reports every error with its node and fills nothing", () => {
    const { errors } = run("locating", TWO_ERRORS, {});
    expect(errors).toHaveLength(2);
    expect(errors[0]!.parentSchema).toEqual(TWO_ERRORS);
    expect(run("locating", DEFAULTED, {}).value).toEqual({});
  });

  it("schema-validate stops at the first error, removes undeclared members and fills nothing", () => {
    expect(run("schema-validate", TWO_ERRORS, {}).errors).toHaveLength(1);
    expect(run("schema-validate", CLOSED, { kept: "k", dropped: 1 })).toMatchObject({ valid: true, value: { kept: "k" } });
    expect(run("schema-validate", DEFAULTED, {}).value).toEqual({});
  });

  it("is strict: false with the pattern seam, the formats and the Telo keywords, in every configuration", () => {
    for (const configuration of SCHEMA_VALIDATION_CONFIGURATIONS) {
      const ajv = createAjv(configuration);
      expect(() => ajv.compile({ "x-telo-widget": "code", unknownKeyword: 1 }), configuration).not.toThrow();
      expect(() => ajv.compile({ type: "string", pattern: "(?=x)" }), configuration).toThrow(
        'invalid RE2 pattern "(?=x)": invalid or unsupported Perl syntax',
      );
      const regex = ajv.compile({ type: "string", format: "regex" });
      expect([regex("(?=x)"), regex("\\x{41}")], configuration).toEqual([false, true]);
      expect(ajv.compile({ type: "string", format: "language-tag" })("en-GB"), configuration).toBe(true);
    }
  });
});

describe("a schema pattern is RE2", () => {
  const findingsOf = (schema: Record<string, unknown>) =>
    new StaticAnalyzer()
      .analyze(
        withSyntheticPositions([
          { kind: "Telo.Definition", metadata: { name: "Thing", module: "test" }, capability: "Telo.Invocable", schema },
        ] as unknown as ResourceManifest[]),
      )
      .filter((diagnostic) => diagnostic.code === "SCHEMA_VIOLATION" || diagnostic.code === "SCHEMA_COMPILE_ERROR")
      .map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: (diagnostic.data as { path?: string }).path,
      }));

  it("reports a lookahead pattern in a kind's schema as SCHEMA_VIOLATION at the pattern, never as a compile error", () => {
    expect(findingsOf({ type: "object", properties: { code: { type: "string", pattern: "^(?!tmp$)[a-z]+$" } } })).toEqual([
      {
        code: "SCHEMA_VIOLATION",
        message: 'Telo.Definition/Thing: /schema/properties/code/pattern invalid RE2 pattern "^(?!tmp$)[a-z]+$": invalid or unsupported Perl syntax',
        path: "schema.properties.code.pattern",
      },
    ]);
  });

  it("judges a pattern no validator would compile, at the place that holds it", () => {
    expect(findingsOf({ type: "object", definitions: { Unused: { type: "string", pattern: "a(?=b)" } } })).toEqual([
      { code: "SCHEMA_VIOLATION", message: 'Telo.Definition/Thing: /schema/definitions/Unused/pattern invalid RE2 pattern "a(?=b)": invalid or unsupported Perl syntax', path: "schema.definitions.Unused.pattern" },
    ]);
    expect(findingsOf({ type: "object", properties: { names: { type: "object", patternProperties: { "(?<=x)": {} } } } })).toEqual([
      { code: "SCHEMA_VIOLATION", message: 'Telo.Definition/Thing: /schema/properties/names/patternProperties invalid RE2 pattern "(?<=x)": invalid named capture', path: "schema.properties.names.patternProperties" },
    ]);
  });
});


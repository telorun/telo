import { withoutStandInFindings, type StandIns } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { stripCompiledValues } from "../src/schema-compiled-values.js";
import { SchemaValidationError, SchemaValidator } from "../src/schema-validator.js";

const SECONDS = { type: "string", pattern: "^\\d+s$" };
const tagged = (engine: string, source: string) => ({ __compiled: true, engine, source });
const interpolated = tagged("interpolate", "${{ s }}s");

const closed = (properties: Record<string, any>, required: string[]) => ({
  type: "object",
  required,
  additionalProperties: false,
  properties,
});

/**
 * Create-time validation as the kernel runs it: the config with its stand-ins
 * in place, and — on a failure with a stand-in recorded — every finding judged.
 * Answers what refuses the resource (nothing, when it is created) and the
 * validated copy.
 */
function createTime(schema: Record<string, any>, config: Record<string, unknown>) {
  const standIns: StandIns = new Map();
  const stripped = stripCompiledValues(
    { kind: "Self.Thing", metadata: { name: "thing" }, ...config },
    schema,
    undefined,
    undefined,
    standIns,
  ) as Record<string, unknown>;
  const validator = new SchemaValidator();
  try {
    validator.compile(schema).validate(stripped);
    return { refusedBy: [], stripped };
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) throw error;
    if (standIns.size === 0) return { refusedBy: ["the first error"], stripped };
  }
  const findings = validator.findingsFor(schema);
  const remaining = withoutStandInFindings(findings(schema, stripped), {
    value: stripped,
    schema,
    standIns,
    validate: findings,
  });
  return { refusedBy: remaining.map((e) => `${e.instancePath} ${e.keyword}`), stripped };
}

/**
 * Create-time validation of a config holding a stand-in: a failure is judged
 * again on every error, each union decided branch by branch, so a stand-in
 * satisfying a union never takes a finding raised beside that union with it.
 */
describe("create-time validation with a stand-in recorded", () => {
  it("keeps a sibling reference's required member beside a union the stand-in satisfies", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        cfg: {
          $ref: "#/$defs/Base",
          anyOf: [{ type: "object", properties: { a: SECONDS } }, { type: "integer" }],
        },
      },
      $defs: { Base: { type: "object", required: ["b"] } },
    };
    expect(createTime(schema, { cfg: { a: interpolated } }).refusedBy).toEqual(["/cfg required"]);
  });

  it("creates a resource whose union branches each default a discriminator", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        retry: {
          oneOf: [
            closed({ mode: { enum: ["fixed"], default: "fixed" }, after: SECONDS }, ["after"]),
            closed({ mode: { enum: ["backoff"], default: "backoff" }, base: SECONDS }, ["base"]),
          ],
        },
      },
    };
    const { refusedBy, stripped } = createTime(schema, { retry: { base: interpolated } });
    expect(refusedBy).toEqual([]);
    expect(stripped.retry).toEqual({ base: "" });
  });

  it("creates a resource fitting the branch after one that defaults a member", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        cfg: {
          anyOf: [
            closed({ kind: { const: "a" }, extra: { type: "string", default: "d" }, t: SECONDS }, ["kind"]),
            closed({ kind: { const: "b" }, t: SECONDS }, ["kind"]),
          ],
        },
      },
    };
    const { refusedBy, stripped } = createTime(schema, { cfg: { kind: "b", t: interpolated } });
    expect(refusedBy).toEqual([]);
    expect(stripped.cfg).toEqual({ kind: "b", t: "" });
  });

  it("refuses a member only its union branch defaults, as it refuses the literal twin", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        retry: {
          anyOf: [
            closed({ mode: { type: "string", default: "backoff" }, base: SECONDS }, ["mode", "base"]),
            { type: "integer" },
          ],
        },
      },
    };
    expect(createTime(schema, { retry: { base: interpolated } }).refusedBy).toEqual([
      "/retry required",
      "/retry type",
      "/retry anyOf",
    ]);
    expect(createTime(schema, { retry: { base: "5s" } }).refusedBy).toEqual(["the first error"]);
  });

  it("fills a default outside any union that the first error stopped short of", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        wait: SECONDS,
        inner: {
          type: "object",
          required: ["mode"],
          properties: { mode: { type: "string", default: "fixed" } },
        },
      },
    };
    const { refusedBy, stripped } = createTime(schema, { wait: interpolated, inner: {} });
    expect(refusedBy).toEqual([]);
    expect(stripped.inner).toEqual({ mode: "fixed" });
  });

  // The validator compiles a recursive shape as a function of its own, which
  // fills its defaults even when a union branch calls it — on a passing
  // validation too, so the stand-in twin must see the same value.
  it("fills what a union branch's recursive shape defaults, as a passing validation does", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        wait: SECONDS,
        node: { anyOf: [{ $ref: "#/$defs/Tree" }, { type: "integer" }] },
      },
      $defs: {
        Tree: closed(
          {
            label: SECONDS,
            mode: { type: "string", default: "leaf" },
            children: { type: "array", items: { $ref: "#/$defs/Tree" } },
          },
          ["label", "mode"],
        ),
      },
    };
    const literal = createTime(schema, { wait: "5s", node: { label: "5s" } });
    expect(literal.refusedBy).toEqual([]);
    expect(literal.stripped.node).toEqual({ label: "5s", mode: "leaf" });
    // `wait` fails first, so only the pass run to completion reaches `node`.
    const standIn = createTime(schema, { wait: interpolated, node: { label: interpolated } });
    expect(standIn.refusedBy).toEqual([]);
    expect(standIn.stripped.node).toEqual({ label: "", mode: "leaf" });
  });

  it("merges the fills into a value holding a 64-bit integer", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        wait: SECONDS,
        inner: {
          type: "object",
          required: ["mode"],
          properties: { count: { type: "integer" }, mode: { type: "string", default: "fixed" } },
        },
      },
    };
    const { refusedBy, stripped } = createTime(schema, { wait: interpolated, inner: { count: 5n } });
    expect(refusedBy).toEqual([]);
    expect(stripped.inner).toEqual({ count: 5n, mode: "fixed" });
  });

  describe("the same expression twice in a uniqueItems list", () => {
    // Runtime-eval: nothing expands the field at creation, so this is the only
    // place the pair is judged before dispatch.
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        tags: { type: "array", uniqueItems: true, "x-telo-eval": "runtime", items: { type: "string" } },
      },
    };

    it("refuses a repeatable pair", () => {
      const word = () => tagged("cel", "variables.word");
      expect(createTime(schema, { tags: [word(), word()] }).refusedBy).toEqual(["/tags uniqueItems"]);
    });

    it("creates a pair that differs per evaluation", () => {
      const id = () => tagged("cel", "uuidv4()");
      expect(createTime(schema, { tags: [id(), id()] }).refusedBy).toEqual([]);
    });
  });
});

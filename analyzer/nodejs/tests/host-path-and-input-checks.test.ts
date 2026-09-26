import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import {
  celTypeSatisfiesJsonSchema,
  checkSchemaCompatibility,
  validateAgainstSchema,
} from "../src/schema-compat.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** `file` is the union a SQLite connection declares: an in-memory constant
 *  beside a host path. `root` is a plain host path. */
const KIND = {
  kind: "Telo.Definition",
  metadata: { name: "Store", module: "App" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      file: {
        "x-telo-eval": "compile",
        anyOf: [{ const: ":memory:" }, { type: "string", "x-telo-type": "Telo.HostPath" }],
      },
      root: { type: "string", "x-telo-type": "Telo.HostPath", "x-telo-eval": "compile" },
    },
  },
};

function app(variables: Record<string, unknown>): Record<string, unknown> {
  return { kind: "Telo.Application", metadata: { name: "App" }, variables };
}

const PATH_VARIABLE = { env: "DB", type: "string", "x-telo-type": "Telo.HostPath", default: "a.db" };

function analyze(variables: Record<string, unknown>, fields: Record<string, unknown>) {
  const store = { kind: "App.Store", metadata: { name: "store" }, ...fields };
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app(variables), KIND, store] as unknown as ResourceManifest[]))
    .filter((d) => d.severity === 1)
    .map((d) => ({ code: d.code, message: d.message }));
}

const cel = (expr: string) => makeTaggedSentinel("cel", expr);

describe("an expression at a union beside a host path", () => {
  it("accepts a host-path source, a joined one and the constant written as a literal", () => {
    expect(analyze({ db: PATH_VARIABLE }, { file: cel("variables.db") })).toEqual([]);
    expect(analyze({ db: PATH_VARIABLE }, { file: cel("variables.db.joinPath('x.db')") })).toEqual([]);
    expect(analyze({ db: PATH_VARIABLE }, { file: cel("':memory:'") })).toEqual([]);
  });

  it("reads the constant off the parsed expression and off a source declared over it", () => {
    expect(analyze({ db: PATH_VARIABLE }, { file: cel("(':memory:')") })).toEqual([]);
    const constant = { env: "DB", type: "string", const: ":memory:", default: ":memory:" };
    expect(analyze({ db: constant }, { file: cel("variables.db") })).toEqual([]);
    const oneOf = { env: "DB", type: "string", enum: [":memory:"], default: ":memory:" };
    expect(analyze({ db: oneOf }, { file: cel("variables.db") })).toEqual([]);
    const wider = { env: "DB", type: "string", enum: [":memory:", "a.db"], default: ":memory:" };
    expect(analyze({ db: wider }, { file: cel("variables.db") }).map((d) => d.code)).toEqual([
      "HOST_PATH_UNTYPED_SOURCE",
    ]);
  });

  it("refuses a plain string — the constant branch does not admit any string", () => {
    const plain = { env: "DB", type: "string", default: "a.db" };
    expect(analyze({ db: plain }, { file: cel("variables.db") })).toEqual([
      expect.objectContaining({
        code: "HOST_PATH_UNTYPED_SOURCE",
        message: expect.stringContaining("The field also accepts ':memory:'."),
      }),
    ]);
    expect(analyze({ db: PATH_VARIABLE }, { file: cel("string(variables.db)") })).toEqual([
      expect.objectContaining({ code: "HOST_PATH_UNTYPED_SOURCE" }),
    ]);
  });

  it("reports a value that is not text as a type mismatch naming both branches", () => {
    expect(analyze({ n: { env: "N", type: "integer", default: 1 } }, { file: cel("variables.n") })).toEqual([
      expect.objectContaining({
        code: "CEL_TYPE_ERROR",
        message: expect.stringContaining(`the field expects '":memory:" | Telo.HostPath'`),
      }),
    ]);
  });
});

describe("a module input declaration", () => {
  it("reports an unknown value type on a variable", () => {
    const typo = { ...PATH_VARIABLE, "x-telo-type": "Telo.HostPth" };
    expect(analyze({ db: typo }, {}).map((d) => d.code)).toContain("X_TELO_TYPE_UNKNOWN");
  });

  it("reports a type a brand's base contradicts, but not a misspelt type name", () => {
    const conflict = { env: "DB", type: "integer", "x-telo-type": "Telo.HostPath" };
    expect(analyze({ db: conflict }, {}).map((d) => d.code)).toEqual(["X_TELO_TYPE_BASE_MISMATCH"]);
    const misspelt = { ...PATH_VARIABLE, type: "strng" };
    expect(analyze({ db: misspelt }, {}).map((d) => d.code)).not.toContain(
      "X_TELO_TYPE_BASE_MISMATCH",
    );
  });

  it("checks a default against the input's declaration, anchoring a relative host path", () => {
    expect(analyze({ db: PATH_VARIABLE }, {})).toEqual([]);
    expect(analyze({ n: { env: "N", type: "string", default: 123 } }, {})).toEqual([
      expect.objectContaining({
        code: "DEFAULT_INVALID",
        message: expect.stringContaining("the default of variables.n must be string."),
      }),
    ]);
    const bytes = { env: "K", type: "string", "x-telo-type": "Telo.Bytes", default: "not.base64" };
    expect(analyze({ k: bytes }, {}).map((d) => d.code)).toEqual(["DEFAULT_INVALID"]);
  });

  it("leaves a default holding a tag at any depth to the tag's own finding", () => {
    const nested = {
      env: "O",
      type: "object",
      additionalProperties: { type: "string" },
      default: { a: makeTaggedSentinel("include-text", "./x") },
    };
    expect(analyze({ o: nested }, {}).map((d) => d.code)).not.toContain("DEFAULT_INVALID");
  });

  it("refuses an empty env name", () => {
    expect(analyze({ db: { ...PATH_VARIABLE, env: "" } }, {}).map((d) => d.code)).toEqual([
      "SCHEMA_VIOLATION",
    ]);
  });
});

describe("an undeclared read at a host-path field", () => {
  it("names the undeclared field and what is declared", () => {
    expect(analyze({ db: PATH_VARIABLE }, { root: cel("variables.dbb") })).toEqual([
      {
        code: "CEL_UNKNOWN_FIELD",
        message: expect.stringContaining("'variables.dbb' is not defined (available: db)"),
      },
    ]);
  });
});

describe("a CEL type error on a brand", () => {
  it("says how to use a brand where its base is expected", () => {
    expect(analyze({ db: PATH_VARIABLE }, { root: cel("variables.db + '/x'") })).toEqual([
      expect.objectContaining({
        code: "CEL_TYPE_ERROR",
        message: expect.stringContaining(".joinPath('sub/dir'), which keeps it a Telo.HostPath"),
      }),
    ]);
  });
});

describe("celTypeSatisfiesJsonSchema", () => {
  it("reads a constant branch by the type of its constant", () => {
    const union = { anyOf: [{ const: ":memory:" }, { type: "integer" }] };
    expect(celTypeSatisfiesJsonSchema("int", union)).toBe(true);
    expect(celTypeSatisfiesJsonSchema("bool", union)).toBe(false);
  });
});

describe("checkSchemaCompatibility at a host path", () => {
  const hostPath = { type: "string", "x-telo-type": "Telo.HostPath" };
  const compatible = (source: Record<string, unknown>, target: Record<string, unknown>) =>
    checkSchemaCompatibility(source, target).compatible;

  it("refuses a plain string, and accepts a host path or a source that says nothing", () => {
    expect(compatible({ type: "string" }, hostPath)).toBe(false);
    expect(compatible(hostPath, hostPath)).toBe(true);
    expect(compatible({}, hostPath)).toBe(true);
  });

  it("accepts a plain string at a union only through a branch that takes one", () => {
    expect(compatible({ type: "string" }, { anyOf: [{ type: "integer" }, hostPath] })).toBe(false);
    expect(compatible({ type: "string" }, { anyOf: [{ type: "string" }, hostPath] })).toBe(true);
  });

  it("still lets a host path flow into a plain string slot", () => {
    expect(compatible(hostPath, { type: "string" })).toBe(true);
  });
});

describe("schema issue reduction", () => {
  it("reports a wrong JSON type once, not again as each keyword it then fails", () => {
    const issues = validateAgainstSchema(5, { type: "string", enum: ["a", "b"] });
    expect(issues.map((i) => i.keyword)).toEqual(["type"]);
  });
});

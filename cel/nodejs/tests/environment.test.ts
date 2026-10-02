import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";

/** A name no host of this engine uses, so a test's vocabulary is its own. */
const MONEY = {
  name: "Money",
  base: "int",
  description: "an amount in the smallest unit",
};

describe("registration", () => {
  it("registers a function, overrides one signature exactly, and removes one", () => {
    const environment = new CelEnvironment();
    expect(environment.check("duration('30d')").typeName).toBe("google.protobuf.Duration");

    // The capability the package exists for: a standard signature is replaceable.
    environment.registerType(MONEY).registerFunction("duration(string): Money");
    expect(environment.check("duration('30d')").typeName).toBe("Money");
    const signatures = environment.definitions().functions.map((entry) => entry.signature);
    expect(signatures).toContain("duration(string): Money");
    expect(signatures).not.toContain("duration(string): google.protobuf.Duration");

    // Removal is by the same exact key: the name's other overload stays, so the call
    // becomes a type error...
    expect(environment.removeFunction("duration(string): Money")).toBe(true);
    expect(environment.check("duration('30d')").diagnostics.map((held) => held.code)).toEqual([
      "CEL_TYPE_ERROR",
    ]);
    // ...and emptying the name is what makes a call to it unknown.
    expect(environment.removeFunctionsNamed("duration")).toBe(1);
    expect(environment.check("duration('30d')").diagnostics.map((held) => held.code)).toEqual([
      "CEL_UNKNOWN_FUNCTION",
    ]);
  });

  it("removes every overload of a name, so a call to it is unknown", () => {
    const environment = new CelEnvironment();
    expect(environment.removeFunctionsNamed("size")).toBeGreaterThan(1);
    expect(environment.check("size('abc')").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FUNCTION");
    expect(environment.check("'abc'.size()").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FUNCTION");
  });

  it("adds an overload beside an existing one rather than replacing it", () => {
    const environment = new CelEnvironment().registerType(MONEY);
    environment.registerFunction("string(Money): string");
    expect(environment.check("string(1)").typeName).toBe("string");
    const named = environment.definitions().functions.filter((entry) => entry.name === "string");
    expect(named.map((entry) => entry.signature)).toContain("string(Money): string");
    expect(named.length).toBeGreaterThan(2);
  });

  it("lets a clone diverge without touching its parent", () => {
    const parent = new CelEnvironment().registerVariable("port", "int");
    const child = parent.clone();
    child.removeFunctionsNamed("size");
    child.registerVariable("host", "string");
    expect(parent.check("size('a')").valid).toBe(true);
    expect(child.check("size('a')").valid).toBe(false);
    expect(parent.hasVariable("host")).toBe(false);
    expect(child.hasVariable("port")).toBe(true);
  });

  it("registers an operator, a constant and a described variable, and lists them", () => {
    const environment = new CelEnvironment()
      .registerType(MONEY)
      .registerOperator("+", ["Money", "Money"], "Money")
      .registerConstant("zero", "Money", { description: "no money at all" })
      .registerVariable("paid", "Money", { description: "what was paid" });
    expect(environment.check("paid + zero").typeName).toBe("Money");
    expect(environment.hasVariable("zero")).toBe(true);
    const definitions = environment.definitions();
    expect(definitions.variables.filter((variable) => variable.name === "zero")).toEqual([
      { name: "zero", type: { kind: "nominal", name: "Money", base: { kind: "primitive", name: "int" }, args: [] }, typeName: "Money", constant: true, description: "no money at all" },
    ]);
    expect(definitions.variables.find((variable) => variable.name === "paid")?.constant).toBe(false);
    expect(definitions.types).toEqual([
      { name: "Money", base: "int", parameters: [], description: "an amount in the smallest unit" },
    ]);
  });

  it("carries the options the host asked for, and defaults to the language's own", () => {
    const strict = new CelEnvironment();
    expect({
      unlistedVariablesAreDyn: strict.options.unlistedVariablesAreDyn,
      homogeneousAggregateLiterals: strict.options.homogeneousAggregateLiterals,
      enableOptionalTypes: strict.options.enableOptionalTypes,
    }).toEqual({
      unlistedVariablesAreDyn: false,
      homogeneousAggregateLiterals: false,
      enableOptionalTypes: false,
    });
    expect(strict.check("whatever").diagnostics[0]?.code).toBe("CEL_UNKNOWN_IDENTIFIER");
    expect(strict.check("[1, 'a']").typeName).toBe("list");
    expect(strict.check("optional.of(1)").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FUNCTION");

    const loose = new CelEnvironment({
      unlistedVariablesAreDyn: true,
      homogeneousAggregateLiterals: true,
      enableOptionalTypes: true,
    });
    expect(loose.check("whatever").typeName).toBe("dyn");
    expect(loose.check("[1, 'a']").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
    expect(loose.check("optional.of(1).hasValue()").typeName).toBe("bool");
    expect(loose.clone().options.unlistedVariablesAreDyn).toBe(true);
  });

  it("holds the well-known type names under `google`", () => {
    const environment = new CelEnvironment();
    expect(environment.check("type(timestamp('2026-01-01T00:00:00Z')) == google.protobuf.Timestamp").typeName).toBe(
      "bool",
    );
    expect(environment.definitions().variables.find((variable) => variable.name === "google")?.typeName).toBe(
      "map<string, map<string, type>>",
    );
  });

  it("answers whether a type converts to text, which is the environment's own string()", () => {
    const environment = new CelEnvironment().registerType(MONEY);
    const typeOf = (source: string) => environment.check(source).type;
    expect(environment.convertsToString(typeOf("1"))).toBe(true);
    expect(environment.convertsToString(typeOf("[1]"))).toBe(false);
    expect(environment.convertsToString(typeOf("dyn(1)"))).toBe(true);
    // A named type converts only once its host registers the conversion.
    environment.registerVariable("paid", "Money");
    expect(environment.convertsToString(typeOf("paid"))).toBe(false);
    environment.registerFunction("string(Money): string");
    expect(environment.convertsToString(typeOf("paid"))).toBe(true);
  });
});

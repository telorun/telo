import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import { CelTypeRegistrationError } from "../src/nominal-type.js";

/** Invented names: the engine owns the mechanism and knows no host's vocabulary. */
const LABEL = {
  name: "Label",
  base: "string",
  comparisons: ["==", "!="],
  conversions: ["string(Self): string"],
  members: ["Self.withSuffix(string): Self"],
};

const HOLDER = {
  name: "Holder",
  base: "list<A>",
  parameters: ["A"],
  members: ["Self.first(): A", "Self.plus(Self): Self"],
};

describe("a named type over a base", () => {
  it("is not its base: the base's own operators and slots refuse it", () => {
    const environment = new CelEnvironment()
      .registerType(LABEL)
      .registerVariable("label", "Label")
      .registerVariable("text", "string")
      .registerFunction("shout(Label): Label");
    expect(environment.check("label.withSuffix('-x')").typeName).toBe("Label");
    expect(environment.check("string(label)").typeName).toBe("string");
    expect(environment.check("label == label").typeName).toBe("bool");

    // A plain string does not stand where the named type is wanted...
    expect(environment.check("shout('plain')").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
    // ...and the base's operators do not apply to it until its host registers them.
    expect(environment.check("label + text").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
    expect(environment.check("label.startsWith('x')").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
  });

  it("holds its type arguments invariantly, and says so when they differ", () => {
    const environment = new CelEnvironment()
      .registerType(HOLDER)
      .registerVariable("strings", "Holder<string>")
      .registerVariable("ints", "Holder<int>")
      .registerFunction("firstText(Holder<string>): string");
    expect(environment.check("strings.first()").typeName).toBe("string");
    expect(environment.check("ints.first()").typeName).toBe("int");
    expect(environment.check("firstText(strings)").typeName).toBe("string");
    expect(environment.check("strings.plus(strings)").typeName).toBe("Holder<string>");

    const mismatched = environment.check("strings.plus(ints)");
    expect(mismatched.diagnostics[0]?.code).toBe("CEL_TYPE_ARGUMENT_MISMATCH");
    expect(mismatched.diagnostics[0]?.message).toContain("Holder<string>");
    expect(environment.check("firstText(ints)").diagnostics[0]?.code).toBe("CEL_TYPE_ARGUMENT_MISMATCH");
  });

  it("refuses a registration that would redefine the language or hide a parameter", () => {
    const environment = new CelEnvironment();
    expect(() => environment.registerType({ name: "map", base: "int" })).toThrow(CelTypeRegistrationError);
    expect(() => environment.registerType({ name: "T", base: "int" })).toThrow(CelTypeRegistrationError);
    expect(() => environment.registerType({ name: "Weird", base: "Unknown" })).toThrow(
      CelTypeRegistrationError,
    );
    expect(() => environment.registerType({ name: "Bad", base: "int", parameters: ["Element"] })).toThrow(
      CelTypeRegistrationError,
    );
  });

  it("names the host's own type in the definition listing, with its base", () => {
    const listing = new CelEnvironment().registerType(HOLDER).definitions();
    expect(listing.types).toEqual([{ name: "Holder", base: "list<A>", parameters: ["A"] }]);
    expect(listing.functions.filter((entry) => entry.name === "first")).toEqual([
      {
        name: "first",
        signature: "Holder<A>.first(): A",
        receiverType: "Holder<A>",
        parameters: [],
        returns: "A",
        deterministic: true,
        hostBacked: false,
        origin: "type:Holder",
      },
    ]);
  });
});

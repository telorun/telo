import { describe, expect, it } from "vitest";
import { CEL_VALUE_TYPE, type CelValue } from "../src/cel-value.js";
import { CelEnvironment } from "../src/environment.js";
import { answerText, emittedPrograms } from "./emitted-host.js";

/** Invented names: the engine owns the mechanism and knows no host's vocabulary. */
const PLACE = {
  name: "Place",
  base: "dyn",
  fields: { street: "string", number: "int", tags: "map<string, string>" },
};

function environment(): CelEnvironment {
  return new CelEnvironment({ enableOptionalTypes: true })
    .registerType(PLACE)
    .registerVariable("p", "Place")
    .registerFunction("string(Place): string", {
      implementation: (ctx, value) => `place:${(value as unknown as { street: string }).street}`,
    });
}

/** A value of the type: its own entries, one of them a name the type does not declare. */
const place = {
  [CEL_VALUE_TYPE]: "Place",
  street: "Main",
  tags: { kind: "shop" },
  hidden: "not a field",
} as unknown as CelValue;

const SOURCES = [
  "p.street",
  "p['street']",
  "p.tags.kind",
  "has(p.street)",
  "has(p.number)",
  "p.?number",
  "p.?street",
  "p.number",
  "dyn(p).hidden",
  "has(dyn(p).hidden)",
  "string(p)",
];

describe("a named type that declares fields", () => {
  it("types each field in every select form, and refuses a name it does not declare", () => {
    const env = environment();
    expect(env.check("p.street").typeName).toBe("string");
    expect(env.check("p['street']").typeName).toBe("string");
    expect(env.check("p.number").typeName).toBe("int");
    expect(env.check("p.?number").typeName).toBe("optional<int>");
    expect(env.check("has(p.number)").typeName).toBe("bool");
    expect(env.check("p.tags.kind").typeName).toBe("string");
    for (const source of ["p.missing", "p.?missing", "has(p.missing)", "p['missing']"]) {
      const diagnostic = env.check(source).diagnostics[0];
      expect(diagnostic?.code, source).toBe("CEL_UNKNOWN_FIELD");
      expect(diagnostic?.message, source).toBe('"missing" is not a field of Place (fields: street, number, tags)');
    }
  });

  it("answers its declared fields from the value's own entries, and nothing else, on both backends", async () => {
    const env = environment();
    const closure = SOURCES.map((source) => answerText(env.compile(source), { p: place }));
    const emitted = (await emittedPrograms(env, SOURCES)).map((program) => answerText(program, { p: place }));
    expect(emitted).toEqual(closure);
    expect(closure.map((answer, at) => `${SOURCES[at]} → ${answer}`)).toMatchInlineSnapshot(`
      [
        "p.street → value string "Main"",
        "p['street'] → value string "Main"",
        "p.tags.kind → value string "shop"",
        "has(p.street) → value bool true",
        "has(p.number) → value bool false",
        "p.?number → value optional()",
        "p.?street → value optional(string "Main")",
        "p.number → error no_such_key [0, 8]",
        "dyn(p).hidden → error no_such_key [0, 13]",
        "has(dyn(p).hidden) → value bool false",
        "string(p) → value string "place:Main"",
      ]
    `);
  });

  it("is part of the environment's digest", () => {
    const other = new CelEnvironment({ enableOptionalTypes: true })
      .registerType({ ...PLACE, fields: { street: "string" } })
      .registerVariable("p", "Place")
      .registerFunction("string(Place): string", { implementation: () => "" });
    expect(other.digest()).not.toBe(environment().digest());
    expect(environment().definitions().types).toEqual([
      {
        name: "Place",
        base: "dyn",
        parameters: [],
        fields: { street: "string", number: "int", tags: "map<string, string>" },
      },
    ]);
  });
});

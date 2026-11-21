import { describe, expect, it } from "vitest";
import { CEL_VALUE_TYPE, celError, type CelValue } from "../src/cel-value.js";
import { CelEnvironment } from "../src/environment.js";
import { CelTypeRegistrationError } from "../src/nominal-type.js";
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

/** A constructible Place: the same fields, and `street` must be written. */
const CONSTRUCTIBLE_PLACE = { ...PLACE, constructible: true, required: ["street"] };

/** Each program's answer, with the message of a failure beside its code and range. */
async function bothBackends(env: CelEnvironment, sources: readonly string[]): Promise<readonly string[]> {
  const emitted = await emittedPrograms(env, sources);
  const answer = (evaluate: () => CelValue): string => {
    let value: CelValue;
    try {
      value = evaluate();
    } catch (cause) {
      const error = cause as { code?: string; range?: readonly number[]; message: string };
      return `error ${error.code} [${error.range?.join(", ")}] ${error.message}`;
    }
    const type = typeof value === "object" && value !== null ? (value as Record<symbol, unknown>)[CEL_VALUE_TYPE] : undefined;
    const text = JSON.stringify(value, (key, held: unknown) => (typeof held === "bigint" ? `${held}n` : held));
    return `value ${text}${type === undefined ? "" : ` as ${String(type)}`}`;
  };
  const closure = sources.map((source) => answer(() => env.compile(source).evaluate()));
  const fromModule = emitted.map((program) => answer(() => program.evaluate()));
  expect(fromModule).toEqual(closure);
  return closure.map((held, at) => `${sources[at]} → ${held}`);
}

describe("a constructible named type", () => {
  it("is built by the engine without a builder, in the form a host builds one, on both backends", async () => {
    const env = new CelEnvironment({ enableOptionalTypes: true }).registerType(CONSTRUCTIBLE_PLACE);
    expect(env.evaluate("Place{street: 'Main', number: 4}")).toEqual({
      [CEL_VALUE_TYPE]: "Place",
      street: "Main",
      number: 4n,
    });
    // Unchecked, a construction the check refuses answers the refusal's own words.
    expect(
      await bothBackends(env, [
        "Place{street: 'Main', number: 4}",
        "Place{?number: optional.none(), street: 'x'}",
        "Place{street: 'x', number: 1 / 0}",
        "Shop{street: 1 / 0}",
        "Shop{}",
        "Place{street: 'x', floor: 2}",
        "Place{street: 'x', street: 'y'}",
        "Place{street: 'x', ?number: 1}",
      ]),
    ).toMatchInlineSnapshot(`
      [
        "Place{street: 'Main', number: 4} → value {"street":"Main","number":"4n"} as Place",
        "Place{?number: optional.none(), street: 'x'} → value {"street":"x"} as Place",
        "Place{street: 'x', number: 1 / 0} → error division_by_zero [27, 32] division by zero",
        "Shop{street: 1 / 0} → error division_by_zero [13, 18] division by zero",
        "Shop{} → error no_matching_overload [0, 6] no type named "Shop" is registered — the closest constructible: Place",
        "Place{street: 'x', floor: 2} → error invalid_argument [0, 28] "floor" is not a field of Place (fields: street, number, tags)",
        "Place{street: 'x', street: 'y'} → error invalid_argument [0, 31] field "street" of Place is written more than once",
        "Place{street: 'x', ?number: 1} → error no_matching_overload [0, 30] an entry written with '?' holds an optional",
      ]
    `);
  });

  it("is built by the host's builder, handed the construction's range and the fields written, on both backends", async () => {
    const handed: unknown[] = [];
    const env = new CelEnvironment({ enableOptionalTypes: true }).registerType(CONSTRUCTIBLE_PLACE, {
      construct: (ctx, fields) => {
        handed.push({ range: ctx.range, fields });
        return fields.street === ""
          ? celError("invalid_argument", "Place: street must not be empty", ctx.range)
          : ({ [CEL_VALUE_TYPE]: "Place", ...fields } as CelValue);
      },
    });
    expect(
      await bothBackends(env, [
        "Place{street: 'Main', ?number: optional.none()}",
        "Place{street: ''}",
      ]),
    ).toMatchInlineSnapshot(`
      [
        "Place{street: 'Main', ?number: optional.none()} → value {"street":"Main"} as Place",
        "Place{street: ''} → error invalid_argument [0, 17] Place: street must not be empty",
      ]
    `);
    expect(handed.slice(0, 2), "the closure backend's two calls").toEqual([
      { range: [0, 47], fields: { street: "Main" } },
      { range: [0, 17], fields: { street: "" } },
    ]);
  });

  it("refuses an == or != that would compare its values, before or after the type", () => {
    const env = new CelEnvironment().registerType(CONSTRUCTIBLE_PLACE);
    const refused = (signature: string, type = "Place") =>
      new CelTypeRegistrationError(
        `${signature} cannot be registered: it would compare values of ${type}, which is constructible, and a constructible type's values are equal exactly when their fields are; normalise the fields in its builder, or register ${type} without constructible`,
      );
    expect(() => env.clone().registerOperator("==", ["Place", "Place"], "bool")).toThrow(refused("==(Place, Place)"));
    expect(() => env.clone().registerOperator("==", ["Place", "string"], "bool")).toThrow(refused("==(Place, string)"));
    expect(() => env.clone().registerOperator("==", ["dyn", "dyn"], "bool")).toThrow(refused("==(dyn, dyn)"));
    expect(() => env.clone().registerOperator("!=", ["A", "A"], "bool")).toThrow(refused("!=(A, A)"));
    expect(() => env.clone().registerOperator("==", ["list<A>", "list<A>"], "bool")).not.toThrow();
    const hosted = new CelEnvironment()
      .registerType(PLACE)
      .registerOperator("==", ["Place", "Place"], "bool", { implementation: () => false });
    expect(() => hosted.registerType(CONSTRUCTIBLE_PLACE)).toThrow(
      new CelTypeRegistrationError(
        "Place cannot be constructible: ==(Place, Place) is registered and would compare its values, and a constructible type's values are equal exactly when their fields are",
      ),
    );
  });

  it("refuses a written value its field's type does not admit, before the builder is called, on both backends", async () => {
    let calls = 0;
    const env = new CelEnvironment().registerType(CONSTRUCTIBLE_PLACE, {
      construct: (ctx, fields) => {
        calls += 1;
        return { [CEL_VALUE_TYPE]: "Place", ...fields } as CelValue;
      },
    });
    expect(await bothBackends(env, ["Place{street: 'a', number: dyn(1.5)}"])).toMatchInlineSnapshot(`
      [
        "Place{street: 'a', number: dyn(1.5)} → error invalid_argument [27, 35] field "number" of Place is int, and this value is double",
      ]
    `);
    expect(calls).toBe(0);
  });

  it("puts constructibility, the required fields and the builder in the digest", () => {
    const digest = (definition: object, construct?: boolean) =>
      new CelEnvironment()
        .registerType({ ...PLACE, ...definition }, construct ? { construct: (ctx, fields) => fields as CelValue } : {})
        .digest();
    const digests = [
      digest({}),
      digest({ constructible: true }),
      digest({ constructible: true, required: ["street"] }),
      digest({ constructible: true }, true),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("refuses a definition no construction could build, and required fields or a builder for a type none can", () => {
    const env = new CelEnvironment();
    expect(() => env.registerType({ name: "Bare", base: "dyn", constructible: true })).toThrow(
      new CelTypeRegistrationError("Bare is constructible and declares no fields; declare `fields`, an empty set for a type with none"),
    );
    expect(() =>
      env.registerType({ name: "Box", base: "dyn", parameters: ["A"], fields: { held: "A" }, constructible: true }),
    ).toThrow(new CelTypeRegistrationError("Box is constructible and takes type parameters, which a construction has no place to write"));
    expect(() => env.registerType({ ...PLACE, constructible: true, required: ["floor"] })).toThrow(
      new CelTypeRegistrationError('required field "floor" of Place is not one of its fields'),
    );
    expect(() => env.registerType({ ...PLACE, required: ["street"] }, { construct: (ctx, fields) => fields as CelValue })).toThrow(
      new CelTypeRegistrationError("Place lists required fields and is not constructible"),
    );
    expect(() => env.registerType(PLACE, { construct: (ctx, fields) => fields as CelValue })).toThrow(
      new CelTypeRegistrationError("Place is given a builder and is not constructible"),
    );
  });
});

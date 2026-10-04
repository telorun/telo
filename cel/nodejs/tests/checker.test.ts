import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/cel-expression.js";
import { CEL_CHECK_CODES, CelEngineError } from "../src/check-diagnostic.js";
import type { CelCheckCode } from "../src/check-diagnostic.js";
import { CelEnvironment } from "../src/environment.js";
import { UNKNOWN_FUNCTION_CANDIDATES } from "../src/function-registry.js";

/** An environment that declares everything legal at its site, as a strict host does. */
function strict(): CelEnvironment {
  return new CelEnvironment({ enableOptionalTypes: true })
    .registerType({ name: "Holder", base: "list<A>", parameters: ["A"] })
    .registerVariable("strings", "Holder<string>")
    .registerVariable("ints", "Holder<int>")
    .registerFunction("firstText(Holder<string>): string")
    .registerVariable("request", {
      schema: {
        type: "object",
        properties: { body: { type: ["object", "null"], properties: { id: { type: "string" } } } },
      },
    })
    .registerNamespace("Billing", ["total(int, int): int"]);
}

/** One cause per code: every code this engine decides, decided by the checker. */
const CAUSES: readonly [CelCheckCode, string][] = [
  ["CEL_SYNTAX_ERROR", "1 +"],
  ["CEL_TYPE_ERROR", "1 + 'a'"],
  ["CEL_UNKNOWN_IDENTIFIER", "nope"],
  ["CEL_UNKNOWN_FIELD", "request.nope"],
  ["CEL_UNKNOWN_FUNCTION", "nosuch(1)"],
  ["CEL_WRONG_CALL_FORM", "startsWith('abc', 'a')"],
  ["CEL_TYPE_ARGUMENT_MISMATCH", "firstText(ints)"],
  ["CEL_NULLABLE_ACCESS", "request.body.id"],
  ["CEL_INVALID_ARGUMENT", "has(1)"],
  ["FUNCTION_UNRESOLVED", "Billing.missing(1)"],
  ["FUNCTION_ARITY_MISMATCH", "Billing.total(1)"],
  ["FUNCTION_ARGUMENT_MISMATCH", "Billing.total(1, 'two')"],
];

describe("the checker decides every verdict, with a range", () => {
  it.each(CAUSES)("decides %s", (code, source) => {
    const result = strict().check(source);
    expect(result.diagnostics[0]?.code, source).toBe(code);
    const range = result.diagnostics[0]!.range;
    expect(range[0], source).toBeGreaterThanOrEqual(0);
    expect(range[1], source).toBeLessThanOrEqual(source.length);
    expect(range[1], source).toBeGreaterThanOrEqual(range[0]);
  });

  it("decides every code of its declared vocabulary", () => {
    const decided = new Set(CAUSES.map(([code]) => code));
    expect(CEL_CHECK_CODES.filter((code) => !decided.has(code))).toEqual([]);
  });
});

describe("a dereference of something that may be null", () => {
  /** A site whose element type admits null, which is where a comprehension meets one. */
  function listOfNullable(): CelEnvironment {
    return new CelEnvironment().registerVariable("rows", {
      schema: {
        type: "array",
        items: { type: ["object", "null"], properties: { code: { type: "string" } } },
      },
    });
  }

  it("is reported for a chain the host declared, and cleared by each of the three guards", () => {
    expect(strict().check("request.body.id").diagnostics[0]?.code).toBe("CEL_NULLABLE_ACCESS");
    for (const guarded of [
      "request.body != null && request.body.id == 'x'",
      "request.body == null || request.body.id == 'x'",
      "request.body == null ? 'x' : request.body.id",
    ]) {
      expect(strict().check(guarded).diagnostics, guarded).toEqual([]);
    }
  });

  it("is not reported for a chain rooted at a name the expression bound", () => {
    // The guard constructs are only half the rule: a comprehension variable is not a subject
    // of this verdict at all, so reporting one would newly reject a manifest that checks today.
    expect(listOfNullable().check("rows.all(e, e.code == 'x')").diagnostics).toEqual([]);
    expect(listOfNullable().check("rows.map(e, e.code)").diagnostics).toEqual([]);
    expect(
      listOfNullable().check("cel.bind(e, rows[0], e.code == 'x')").diagnostics,
    ).toEqual([]);
    // The skip is about the ROOT, not about sitting inside a comprehension: a chain rooted at
    // a name the host declared is still reported from inside one.
    const both = listOfNullable().registerVariable("request", {
      schema: {
        type: "object",
        properties: { body: { type: ["object", "null"], properties: { id: { type: "string" } } } },
      },
    });
    expect(both.check("rows.all(e, request.body.id == 'x')").diagnostics[0]?.code).toBe(
      "CEL_NULLABLE_ACCESS",
    );
  });
});

describe("fixes", () => {
  it("offers the one name a misspelled call could have meant, as a whole source", () => {
    const fix = strict().check("'abc'.startswith('a') && true").diagnostics[0]?.fix;
    expect(fix).toEqual({ replacement: '"abc".startsWith("a") && true' });
  });

  it("offers the call's other form, parenthesizing the receiver when it must", () => {
    const environment = new CelEnvironment().registerFunction("int.scaled(int): int");
    expect(environment.check("scaled(1 + 2, 3)").diagnostics[0]).toMatchObject({
      code: "CEL_WRONG_CALL_FORM",
      fix: { replacement: "(1 + 2).scaled(3)" },
    });
    const global = new CelEnvironment().registerFunction("scaled(int, int): int");
    expect(global.check("(1 + 2).scaled(3)").diagnostics[0]).toMatchObject({
      code: "CEL_WRONG_CALL_FORM",
      fix: { replacement: "scaled(1 + 2, 3)" },
    });
  });

  it("offers no fix where there is no single repair", () => {
    expect(strict().check("nosuch(1)").diagnostics[0]?.fix).toBeUndefined();
  });
});

/**
 * What a call on a name nothing registers is OFFERED: the registered names that accept its
 * form and arity, nearest first, bounded and ordered by a declared rule.
 *
 * The fixture is built to DISCRIMINATE, which is the only thing that makes it a gate: eight
 * names pass the form-and-arity filter, so a listing of all of them is a broken bound; the
 * nearest five in name order are a different sequence from the nearest five, so an
 * implementation that forgot the distance passes nothing here; and the three nearest are
 * registered in an order that is not their name order, so a tie broken by registration order
 * is a different sequence too. Each of those three is asserted as a control below.
 *
 * **Blind spot:** this is a gate over one call's TEXT. It cannot reach a name whose distance
 * rule differs by host language — every name here is ASCII, so nothing it says binds a port's
 * reading of a non-ASCII name — and it says nothing about a macro (`has`, `map`), which is no
 * registration and so is never a candidate however near it is spelled.
 */
describe("a call on a name nothing registers", () => {
  /** Eight one-argument names, the three nearest registered out of name order. */
  function spellings(): CelEnvironment {
    const environment = new CelEnvironment({ standardLibrary: false });
    for (const name of ["mite", "kites", "kit", "zeta", "beta", "alpha", "delta", "gamma"]) {
      environment.registerFunction(`${name}(int): int`);
    }
    // Nearer than every one of those, and reachable by neither form nor arity of `kite(1)`.
    return environment.registerFunction("kitten(int, int): int").registerFunction("int.kiter(int): int");
  }

  it("names the five nearest of its own form and arity, and no command to run", () => {
    const [diagnostic] = spellings().check("kite(1)").diagnostics;
    expect(diagnostic?.code).toBe("CEL_UNKNOWN_FUNCTION");
    expect(diagnostic?.message).toBe(
      'no function named "kite" is registered — the closest taking 1 argument: kit, kites, mite, beta, zeta',
    );
    // A pointer at a listing command is host vocabulary, and unimplementable in a host
    // that has no command line at all.
    expect(diagnostic?.message).not.toMatch(/telo|command|`/);
  });

  it("answers the same environment with the same text twice", () => {
    const environment = spellings();
    expect(environment.check("kite(1)").diagnostics).toEqual(environment.check("kite(1)").diagnostics);
  });

  it("is a bound and an order the fixture can see broken", () => {
    const environment = spellings();
    const offered = environment
      .check("kite(1)")
      .diagnostics[0]!.message.split(": ")
      .at(-1)!
      .split(", ");
    expect(offered).toHaveLength(UNKNOWN_FUNCTION_CANDIDATES);

    // The bound is real: eight names pass the filter, so an unbounded list would differ.
    const eligible = environment
      .definitions()
      .functions.filter((held) => held.parameters.length === 1 && held.receiverType === null)
      .map((held) => held.name);
    expect(eligible).toHaveLength(8);

    // The order is distance-then-name: name order alone, and the nearest three in
    // registration order, are both other sequences.
    expect(offered).not.toEqual([...eligible].sort().slice(0, UNKNOWN_FUNCTION_CANDIDATES));
    expect(offered.slice(0, 3)).not.toEqual(["mite", "kites", "kit"]);
  });

  it("names nothing where no registration accepts the call's form and arity", () => {
    expect(new CelEnvironment({ standardLibrary: false }).check("kite(1)").diagnostics[0]?.message).toBe(
      'no function named "kite" is registered',
    );
  });
});

describe("the per-call resolved-signature listing", () => {
  it("names the signature each call resolved to, with the metadata the host declared", () => {
    const environment = new CelEnvironment()
      .registerFunction("sha256(string): string", {
        deterministic: true,
        hostBacked: true,
        throws: ["ERR_DIGEST_FAILED"],
      })
      .registerFunction("now(): int", { deterministic: false })
      .registerNamespace("Billing", [
        { signature: "total(int): int", deterministic: false, hostBacked: true, throws: ["ERR_BILLING"] },
      ]);
    expect(environment.check("sha256('a') + string(now()) + string(Billing.total(1))").calls).toEqual([
      {
        name: "sha256",
        form: "global",
        arity: 1,
        range: [0, 11],
        signature: "sha256(string): string",
        returns: "string",
        deterministic: true,
        hostBacked: true,
        throws: ["ERR_DIGEST_FAILED"],
      },
      {
        name: "now",
        form: "global",
        arity: 0,
        range: [21, 26],
        signature: "now(): int",
        returns: "int",
        deterministic: false,
        hostBacked: false,
      },
      {
        name: "string",
        form: "global",
        arity: 1,
        range: [14, 27],
        signature: "string(int): string",
        returns: "string",
        deterministic: true,
        hostBacked: false,
      },
      {
        name: "Billing.total",
        form: "receiver",
        namespace: "Billing",
        arity: 1,
        range: [37, 53],
        // Each argument's own type, which only a NAMESPACED call carries: the host judges
        // such a call against its own signature grammar, and checking an argument's subtree
        // on its own would lose whatever the expression bound around it.
        argumentTypes: ["int"],
        signature: "total(int): int",
        returns: "int",
        deterministic: false,
        hostBacked: true,
        throws: ["ERR_BILLING"],
      },
      {
        name: "string",
        form: "global",
        arity: 1,
        range: [30, 54],
        signature: "string(int): string",
        returns: "string",
        deterministic: true,
        hostBacked: false,
      },
    ]);
  });

  it("lists no entry for a macro, which reaches no function", () => {
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true });
    expect(environment.check("[1, 2].map(i, size(string(i)))").calls.map((call) => call.name)).toEqual([
      "string",
      "size",
    ]);
    expect(environment.check("has(a.b) && cel.bind(x, 1, x > 0)").calls).toEqual([]);
  });
});

describe("qualified calls", () => {
  it("types from the namespace's declared signature", () => {
    expect(strict().check("Billing.total(1, 2) + 1").typeName).toBe("int");
  });

  it("refuses a tree resolved under another namespace set rather than checking it", () => {
    const environment = strict();
    const elsewhere = parseExpression("Billing.total(1, 2)", { namespaces: ["Shop"] });
    expect(() => environment.check(elsewhere)).toThrow(CelEngineError);
    try {
      environment.check(elsewhere);
    } catch (error) {
      expect((error as CelEngineError).code).toBe("namespaces_mismatch");
    }
    // The same source, read by the environment itself, checks.
    expect(environment.check("Billing.total(1, 2)").valid).toBe(true);
  });
});

describe("optional types", () => {
  it("checks every form the option enables", () => {
    const environment = new CelEnvironment({ enableOptionalTypes: true, unlistedVariablesAreDyn: true });
    const check = (source: string) => environment.check(source);
    expect(check("optional.of(1)").typeName).toBe("optional<int>");
    // A parameter nothing resolved is reported as `dyn`, as every use of one is.
    expect(check("optional.none()").typeName).toBe("optional<dyn>");
    expect(check("optional.of(1).hasValue()").typeName).toBe("bool");
    expect(check("optional.of(1).value()").typeName).toBe("int");
    expect(check("optional.of(1).orValue(2)").typeName).toBe("int");
    expect(check("optional.none().or(optional.of(1)).value()").typeName).toBe("int");
    expect(check("{'a': 1}.?a").typeName).toBe("optional<int>");
    expect(check("[1][?0]").typeName).toBe("optional<int>");
    expect(check("{'a': {'b': 2}}.?a.b.orValue(0)").typeName).toBe("int");
  });

  it("has none of it where the option is off", () => {
    const off = new CelEnvironment({ unlistedVariablesAreDyn: true });
    expect(off.check("optional.of(1)").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FUNCTION");
    expect(off.check("optional.of(1).hasValue()").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FUNCTION");
  });
});

describe("a presence-shaped read — `.?`, `[?]`, `has()`", () => {
  /**
   * A field declared as two shapes: a storage-class string, or a reference carrying a
   * name. Declared both directly and through a `$ref`, because a consumer's schema says
   * it either way and the answer must not depend on which.
   */
  function twoShapes(): CelEnvironment {
    const column = {
      anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" } } }],
    };
    return new CelEnvironment({ enableOptionalTypes: true })
      .registerVariable("direct", { schema: { type: "object", properties: { type: column } } })
      .registerVariable("referenced", {
        schema: {
          type: "object",
          properties: { type: { $ref: "#/$defs/Column" } },
          $defs: { Column: column },
        },
      });
  }

  it("discriminates a two-shape field, while the ordinary read of it stays refused", () => {
    for (const root of ["direct", "referenced"]) {
      const check = (source: string) => twoShapes().check(source);
      expect(check(`${root}.type.?name`).diagnostics, root).toEqual([]);
      expect(check(`${root}.type.?name`).typeName, root).toBe("optional<string>");
      expect(check(`${root}.type[?'name']`).typeName, root).toBe("optional<string>");
      expect(check(`has(${root}.type.name)`).diagnostics, root).toEqual([]);
      expect(check(`${root}.type.name`).diagnostics[0]?.code, root).toBe("CEL_TYPE_ERROR");
    }
  });

  it("refuses an operand whose declared type holds no members, in every form alike", () => {
    // The runtime answers absence for all five, so this is where a `.?` over a known
    // scalar is still a mistake: the loosening is reached only through a `dyn`.
    const environment = () =>
      new CelEnvironment({ enableOptionalTypes: true }).registerVariable("text", "string");
    for (const source of ["text.b", "text.?b", "has(text.b)", "text['b']", "text[?'b']"]) {
      const [first] = environment().check(source).diagnostics;
      expect(first?.code, source).toBe("CEL_TYPE_ERROR");
      expect(first?.message, source).toMatch(/^string holds no (members|elements)$/);
    }
    // And a union NO branch of which holds the member is refused in the presence form too.
    const neither = new CelEnvironment({ enableOptionalTypes: true }).registerVariable("either", {
      schema: { anyOf: [{ type: "string" }, { type: "integer" }] },
    });
    expect(neither.check("either.?b").diagnostics.map((held) => held.code)).toEqual([
      "CEL_TYPE_ERROR",
      "CEL_TYPE_ERROR",
    ]);
  });
});

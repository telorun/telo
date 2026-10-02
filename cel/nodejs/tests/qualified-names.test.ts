import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import { qualifiedCalls } from "../src/qualified-calls.js";
import { rootReferences } from "../src/root-references.js";
import { serializeTree } from "../src/serializer.js";

/**
 * A name may be dotted, and a dot may open one.
 *
 * Both are cel-spec's: a host declares `a.b.c` as one name, and `.y` reads what the
 * environment declares rather than what the expression bound. The second is the only
 * spelling Telo has for an outer name where a comprehension variable shares it.
 */

describe("a dotted declaration", () => {
  it("is one name, and the longest declared prefix wins", () => {
    const whole = new CelEnvironment().registerVariable("a.b.c", "string");
    expect(whole.check("a.b.c").typeName).toBe("string");

    const prefix = new CelEnvironment().registerVariable("a.b", "map<string, string>");
    expect(prefix.check("a.b.c").typeName).toBe("string");

    const both = new CelEnvironment()
      .registerVariable("a.b", "map<string, string>")
      .registerVariable("a.b.c", "int");
    expect(both.check("a.b.c").typeName).toBe("int");
    expect(both.check("a.b.d").typeName).toBe("string");
  });

  it("reads its members from there, and refuses one a declared type does not hold", () => {
    const environment = new CelEnvironment()
      .registerVariable("a.b", "list<string>")
      .registerVariable("cfg.http", { schema: { type: "object", properties: { port: { type: "integer" } } } });
    expect(environment.check("cfg.http.port").typeName).toBe("int");
    expect(environment.check("cfg.http.prot").diagnostics[0]?.code).toBe("CEL_UNKNOWN_FIELD");
    // A member read on a list is a type error, whatever the chain that reached it.
    expect(environment.check("a.b.pancakes").diagnostics[0]?.code).toBe("CEL_TYPE_ERROR");
  });

  it("yields to a name the expression itself bound, as a bare name does", () => {
    const environment = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerVariable(
      "a.b",
      "map<string, string>",
    );
    expect(environment.check("a.b.c").typeName).toBe("string");
    // `a` is the comprehension's element here, so `a.b.c` reads the element — which holds
    // an int at `b.c` where the declaration holds a string.
    const bound = environment.check("[{'b': {'c': 1}}].map(a, a.b.c)");
    expect(bound.diagnostics).toEqual([]);
    expect(bound.typeName).toBe("list<int>");
  });

  it("beats an undeclared dotted key the activation also holds, root declaration included", () => {
    // **The declared name wins at evaluation, not just at check.** An activation may hold
    // both — a host binding `a` and, beside it, the literal key `"a.b"` — and the chain must
    // read the name the checker typed. The root-only case was the live hole: the split
    // started at two segments, so a chain whose ROOT alone is declared fell into the
    // activation's prefix search and the undeclared key answered.
    const rootOnly = new CelEnvironment().registerVariable("a", { fields: { b: "int" } });
    expect(rootOnly.check("a.b").typeName).toBe("int");
    expect(rootOnly.evaluate("a.b", { a: { b: 1n }, "a.b": 99n })).toBe(1n);
    // And a dotted declaration still wins over a shorter one, which is the same rule.
    const dotted = new CelEnvironment()
      .registerVariable("a", { fields: { b: "int" } })
      .registerVariable("a.b", "int");
    expect(dotted.evaluate("a.b", { a: { b: 1n }, "a.b": 99n })).toBe(99n);
  });

  it("reads as one name for the free-variable query", () => {
    const environment = new CelEnvironment().registerVariable("a.b.c", "string");
    expect(rootReferences(environment.parse("a.b.c").root)).toEqual(["a"]);
  });
});

describe("an absolute name", () => {
  const environment = () =>
    new CelEnvironment()
      .registerVariable("y", "string")
      .registerVariable("outer", "int")
      .registerNamespace("Alias", ["fn(int): int"]);

  it("resolves against the environment, never against a binding", () => {
    expect(environment().check(".y").typeName).toBe("string");
    expect(environment().check("['a'].exists(y, .y == 'y')").typeName).toBe("bool");
    expect(environment().check("[1].map(outer, .outer + 1)").typeName).toBe("list<int>");
    // Without the dot the binding wins, which is what the dot is for.
    expect(environment().check("['a'].exists(y, y == 'y')").typeName).toBe("bool");
  });

  it("reads a member of what it resolved", () => {
    const nested = new CelEnvironment().registerVariable("y", {
      schema: { type: "object", properties: { z: { type: "string" } } },
    });
    expect(nested.check(".y.z").typeName).toBe("string");
    expect(nested.check("[1].map(y, .y.z)").typeName).toBe("list<string>");
  });

  it("is a name nothing declares when nothing declares it", () => {
    expect(new CelEnvironment().check(".nope").diagnostics[0]?.code).toBe("CEL_UNKNOWN_IDENTIFIER");
    expect(new CelEnvironment({ unlistedVariablesAreDyn: true }).check(".nope").typeName).toBe("dyn");
  });

  it("is never a namespaced call: a call on a namespace has one spelling", () => {
    const absolute = environment().check(".Alias.fn(1)");
    expect(absolute.diagnostics[0]?.code).toBe("CEL_UNKNOWN_IDENTIFIER");
    expect(qualifiedCalls(environment().parse(".Alias.fn(1)").root)).toEqual([]);
    // The one spelling still resolves.
    expect(environment().check("Alias.fn(1)").typeName).toBe("int");
    expect(qualifiedCalls(environment().parse("Alias.fn(1)").root)).toHaveLength(1);
  });

  it("writes back with its dot", () => {
    for (const source of [".y", ".y.z", "[1].map(y, .y)"]) {
      const expression = environment().parse(source);
      expect(expression.diagnostics, source).toEqual([]);
      expect(serializeTree(expression.root)).toBe(source);
    }
  });
});

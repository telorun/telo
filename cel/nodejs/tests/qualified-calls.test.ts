import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/cel-expression.js";
import { qualifiedCalls } from "../src/qualified-calls.js";

describe("the qualified-call query", () => {
  it("answers every namespaced call in source order, with its range", () => {
    const expression = parseExpression("Self.a(Shop.b()) + c.d()", { namespaces: ["Self", "Shop"] });
    expect(qualifiedCalls(expression.root)).toEqual([
      {
        namespace: "Self",
        name: "a",
        qualifiedName: "Self.a",
        arity: 1,
        range: [0, 16],
        nameRange: [5, 6],
      },
      {
        namespace: "Shop",
        name: "b",
        qualifiedName: "Shop.b",
        arity: 0,
        range: [7, 15],
        nameRange: [12, 13],
      },
    ]);
  });

  it("answers a call whose name is a macro's, which the set makes a namespaced call", () => {
    const expression = parseExpression("Shop.map(x, x)", { namespaces: ["Shop"] });
    expect(qualifiedCalls(expression.root).map((call) => call.qualifiedName)).toEqual(["Shop.map"]);
  });

  it("answers nothing for a tree resolved under no namespace", () => {
    expect(qualifiedCalls(parseExpression("Shop.map(x, x)").root)).toEqual([]);
  });
});

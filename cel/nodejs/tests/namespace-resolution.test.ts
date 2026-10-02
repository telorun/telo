import { describe, expect, it } from "vitest";
import { parseExpression, resolvedUnder } from "../src/cel-expression.js";
import { CelNamespaceError, normalizeNamespaces, resolveNamespaces } from "../src/namespace-resolution.js";
import { parseSyntax } from "../src/parser.js";
import { walkTree } from "../src/syntax-tree.js";
import { treesEqual } from "../src/tree-equality.js";

describe("namespace resolution", () => {
  it("cannot be done by the parser: a namespaced call and a method call are one syntax", () => {
    const namespaced = parseSyntax("Billing.total(x)").root;
    const method = parseSyntax("invoice.total(x)").root;
    expect(namespaced.kind).toBe("receiverCall");
    expect(method.kind).toBe("receiverCall");
    // The same shape but for the receiver's name, which is all the parser has.
    expect(treesEqual(namespaced, parseSyntax("invoice.total(x)").root)).toBe(false);
    expect(treesEqual(namespaced, parseSyntax("Billing.total(x)").root)).toBe(true);
  });

  it("produces the one qcall node, from the set alone", () => {
    expect(parseExpression("Billing.total(x)", { namespaces: ["Billing"] }).root).toEqual({
      kind: "qcall",
      namespace: "Billing",
      namespaceRange: [0, 7],
      name: "total",
      nameRange: [8, 13],
      range: [0, 16],
      args: [{ kind: "ident", name: "x", absolute: false, range: [14, 15] }],
    });
    expect(parseExpression("Billing.total(x)").root.kind).toBe("receiverCall");
  });

  it("is total: it resolves a call wherever it is written", () => {
    const resolved = parseExpression("[Billing.a()].all(i, i == Billing.b(Billing.c()))", {
      namespaces: ["Billing"],
    });
    const namespaced = [...walkTree(resolved.root)].filter((node) => node.kind === "qcall");
    expect(namespaced.map((node) => node.kind === "qcall" && node.name)).toEqual(["a", "b", "c"]);
  });

  it("resolves nothing but a call on a bare name of the set", () => {
    const unchanged = ["a.Billing.total(1)", "Billing", "Billing.rate", "Other.total(1)", "total(1)"];
    for (const source of unchanged) {
      const resolved = parseExpression(source, { namespaces: ["Billing"] });
      expect([...walkTree(resolved.root)].some((node) => node.kind === "qcall"), source).toBe(false);
    }
  });

  it("refuses a reserved namespace at registration", () => {
    for (const reserved of ["cel", "optional"]) {
      expect(() => normalizeNamespaces([reserved])).toThrow(CelNamespaceError);
    }
    expect(() => normalizeNamespaces(["if"])).toThrow(CelNamespaceError);
    expect(() => normalizeNamespaces(["a.b"])).toThrow(CelNamespaceError);
    expect(parseExpression("cel.bind(x, 1, x)", { namespaces: ["Billing"] }).root.kind).toBe("receiverCall");
  });

  it("records the set the tree was resolved under", () => {
    const expression = parseExpression("Billing.total(1)", { namespaces: ["Shop", "Billing", "Shop"] });
    expect(expression.namespaces).toEqual(["Billing", "Shop"]);
    expect(resolvedUnder(expression, ["Shop", "Billing"])).toBe(true);
    expect(resolvedUnder(expression, ["Billing"])).toBe(false);
    expect(resolvedUnder(parseExpression("1"), [])).toBe(true);
  });

  it("shares every node it does not rewrite", () => {
    const parsed = parseSyntax("a + b").root;
    expect(resolveNamespaces(parsed, ["Billing"])).toBe(parsed);
  });
});


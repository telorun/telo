import { describe, expect, it } from "vitest";
import { parseExpression } from "../src/cel-expression.js";
import { rootReferences } from "../src/root-references.js";

function refs(source: string, namespaces?: string[]): readonly string[] {
  const expression = parseExpression(source, namespaces ? { namespaces } : undefined);
  expect(expression.diagnostics, source).toEqual([]);
  return rootReferences(expression.root);
}

describe("the root-reference query", () => {
  it("answers the first name of every access chain, once and sorted", () => {
    expect(refs("request.query.limit + request.body.size + xs[0].id")).toEqual(["request", "xs"]);
    expect(refs("size(a) + b.c('d')")).toEqual(["a", "b"]);
    expect(refs("{'k': v}[w] ? y : -z")).toEqual(["v", "w", "y", "z"]);
    expect(refs("1 + 2")).toEqual([]);
  });

  it("excludes a name a comprehension or a binding introduces", () => {
    expect(refs("xs.map(i, i + offset)")).toEqual(["offset", "xs"]);
    expect(refs("xs.filter(i, i > 0).all(j, j < limit)")).toEqual(["limit", "xs"]);
    expect(refs("xs.map(i, i > 0, i * 2)")).toEqual(["xs"]);
    expect(refs("cel.bind(error, {'code': 1}, error.code)")).toEqual([]);
    expect(refs("cel.bind(x, outer, x)")).toEqual(["outer"]);
  });

  it("reads a name again where the binding does not reach it", () => {
    expect(refs("xs.map(i, i) + i")).toEqual(["i", "xs"]);
  });

  it("excludes a namespace, resolved or reserved", () => {
    expect(refs("Billing.total(x)", ["Billing"])).toEqual(["x"]);
    expect(refs("Billing.total(x)")).toEqual(["Billing", "x"]);
    expect(refs("Billing.rate", ["Billing"])).toEqual(["Billing"]);
    expect(refs("optional.of(a).hasValue()")).toEqual(["a"]);
  });
});

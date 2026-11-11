import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { findDynamicRead } from "../src/resource-rule.js";
import { compileRuleCondition } from "../src/rule-condition.js";

/** Over a map a comprehension's variable and an `in` test stand for a KEY, so a
 *  condition about a map's keys does not read its values — an expression a value
 *  holds must not stop the rule running. Over a list they read the elements. */

const compiledOf = (condition: string) => {
  const compiled = compileRuleCondition(condition);
  if (!("reads" in compiled)) throw new Error(`condition did not compile: ${condition}`);
  return compiled;
};
const dynamicRead = (condition: string, roots: Record<string, unknown>) =>
  findDynamicRead(compiledOf(condition).reads, roots);

const computed = () => makeTaggedSentinel("cel", "blocks.size()");
const names = ["path", "content"];

describe("a rule condition over a map whose values are computed", () => {
  const entry = { arguments: { path: computed(), content: computed() } };

  it("reads the keys it iterates, not the values", () => {
    expect(dynamicRead("this.arguments.all(k, k in self.names)", { this: entry, self: { names } })).toBeUndefined();
  });

  it("reads the keys it tests with `in`", () => {
    expect(dynamicRead("self.names.all(n, n in this.arguments)", { this: entry, self: { names } })).toBeUndefined();
  });

  it("reads the values it indexes", () => {
    expect(dynamicRead("this.arguments.all(k, this.arguments[k] != '')", { this: entry })).toMatchObject({
      path: "this.arguments.path",
    });
    expect(dynamicRead("this.arguments.path != ''", { this: entry })).toMatchObject({ path: "this.arguments.path" });
  });

  it("reads the map itself when the map is not yet known", () => {
    const dynamic = { arguments: computed() };
    expect(dynamicRead("this.arguments.all(k, k in self.names)", { this: dynamic, self: { names } })).toMatchObject({
      path: "this.arguments",
    });
  });
});

describe("a rule condition over a list whose elements are computed", () => {
  const entry = { items: ["a", computed()] };

  it("reads the elements it iterates", () => {
    expect(dynamicRead("this.items.all(x, x != '')", { this: entry })).toMatchObject({ path: "this.items[1]" });
  });

  it("reads the elements it tests with `in`", () => {
    expect(dynamicRead("'a' in this.items", { this: entry })).toMatchObject({ path: "this.items[1]" });
  });

  it("stops at an inline declaration, as a read of the whole list does", () => {
    const declared = { items: [{ kind: "Telo.Value", value: computed() }] };
    expect(dynamicRead("this.items.all(x, x != {})", { this: declared })).toBeUndefined();
  });

  it("does not read the elements it only iterates", () => {
    expect(dynamicRead("this.items.all(x, true)", { this: entry })).toBeUndefined();
  });
});

describe("the places a rule reads", () => {
  it("still read a range whole where an iteration variable is used bare", () => {
    expect(compiledOf("this.arguments.all(k, k in self.names)").chains).toContainEqual(["this", "arguments"]);
  });
});

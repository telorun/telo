import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { findDynamicRead } from "../src/resource-rule.js";
import { compileRuleCondition } from "../src/rule-condition.js";

/** A presence test reads whether a member exists, never its value — so an
 *  expression held by the member does not stop the rule running. */

const chainsOf = (condition: string) => {
  const compiled = compileRuleCondition(condition);
  if (!("chains" in compiled)) throw new Error(`condition did not compile: ${condition}`);
  return compiled.chains;
};

describe("a rule condition's presence test", () => {
  const self = { port: makeTaggedSentinel("cel", "ports.http"), listen: { port: 8080 } };

  it("reads the member's existence, not its value", () => {
    expect(chainsOf("!has(self.port)")).toEqual([["self", "?"]]);
    expect(findDynamicRead(chainsOf("!has(self.port)"), { self })).toBeUndefined();
  });

  it("still reads a value it then reads", () => {
    expect(findDynamicRead(chainsOf("has(self.port) && self.port > 0"), { self })).toMatchObject({
      path: "self.port",
    });
  });

  it("reads the owner when the owner itself is not yet known", () => {
    const dynamicOwner = { listen: makeTaggedSentinel("cel", "variables.listen") };
    expect(findDynamicRead(chainsOf("has(self.listen.port)"), { self: dynamicOwner })).toMatchObject({
      path: "self.listen",
    });
  });
});

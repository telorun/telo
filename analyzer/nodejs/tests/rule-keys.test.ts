import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeKeyCosts } from "../src/cel-site-judgements.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";

/** Keys judged per site of `declaration`, by family and written place. */
async function keysOf(name: string, text: string, declaration: string): Promise<Map<string, number>> {
  const loaded = await loadGenerated(name, text);
  const keys = new Map<string, number>();
  const stop = observeKeyCosts((cost) => {
    if (cost.kind !== "door-nodes") return;
    const id = JSON.parse(cost.site) as unknown[];
    const relation = id[0] === "relation";
    if ((relation ? id[3] : id[1]) !== declaration) return;
    const site = relation ? `${cost.family} ${id[1]} ${id[5]}` : `${cost.family} ${id[3] ?? id[4]}`;
    keys.set(site, (keys.get(site) ?? 0) + 1);
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return keys;
}

/** A kind whose resources are judged by a rule `condition` over `self`, as a
 *  resource rule or as a referrer rule of the `holder` referencing one; the
 *  resource holds `label` and `meta.note`, each written as `fields` gives it. */
function ruleFixture(family: "resource" | "referrer", condition: string, fields: { label: string; note: string }): string {
  const rule =
    family === "resource"
      ? ["  x-telo-resource-rules:"]
      : ["  x-telo-referrer-rules:", "    - referrer: Self.Holder"];
  return [
    "kind: Telo.Application",
    "metadata: { name: RuleKeys }",
    "variables:",
    "  flag1: { env: FLAG_1, type: boolean, default: false }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Panel }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    label: { type: string }",
    "    meta: { type: object, properties: { note: { type: string } } }",
    ...rule,
    `    ${family === "resource" ? "- " : "  "}condition: !cel "${condition}"`,
    "      code: PANEL_LABEL",
    "      message: The panel has no label.",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Holder }",
    "capability: Telo.Provider",
    "controllers:",
    "  - pkg:npm/none@0.0.0",
    "schema:",
    "  type: object",
    "  properties:",
    "    panel: { x-telo-ref: { kind: Self.Panel, use: dependency } }",
    "---",
    "kind: Self.Panel",
    "metadata: { name: panel }",
    ...fields.label.split("\n").map((line, i) => (i === 0 ? `label: ${line}` : line)),
    "meta:",
    ...fields.note.split("\n").map((line, i) => (i === 0 ? `  note: ${line}` : `  ${line}`)),
    "---",
    "kind: Self.Holder",
    "metadata: { name: holder }",
    "panel: !ref panel",
    "",
  ].join("\n");
}

const VARYING = ["!if", '  if: !cel "variables.flag1"', "  then: one", "  else: two"].join("\n");

describe("a rule's keys", () => {
  // A presence test reads the member it asks about: a choice inside another
  // field splits no key of the rule's site.
  it("hold one key where a presence test's member is fixed and another field varies", async () => {
    const resource = await keysOf("rule-keys-resource-presence.yaml", ruleFixture("resource", "has(self.label)", { label: "first", note: VARYING }), "panel");
    expect([...resource].filter(([site]) => site.startsWith("relation resourceRules"))).toEqual([["relation resourceRules kind", 1]]);
    const referrer = await keysOf("rule-keys-referrer-presence.yaml", ruleFixture("referrer", "has(self.label)", { label: "first", note: VARYING }), "holder");
    expect([...referrer].filter(([site]) => site.startsWith("relation referrerRules"))).toEqual([["relation referrerRules panel", 1]]);
  }, 120_000);

  // What a rule reads is its own site's read, never a schema key's: the
  // resource holding the member it reads keeps one schema key per site but
  // the one at that member, which its own values split.
  it("leave one schema key per site of the resource holding a varying member a rule reads", async () => {
    for (const family of ["resource", "referrer"] as const) {
      const keys = await keysOf(`rule-keys-${family}-varying.yaml`, ruleFixture(family, "self.label != ''", { label: VARYING, note: "fixed" }), "panel");
      const schema = [...keys].filter(([site]) => site.startsWith("schema"));
      expect(schema.length).toBeGreaterThan(1);
      for (const [site, count] of schema) expect([site, count]).toEqual([site, site === "schema label" ? 2 : 1]);
    }
  }, 120_000);
});

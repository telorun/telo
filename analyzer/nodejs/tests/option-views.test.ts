import { isExpansionSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { relocatePath } from "../src/choice-expansion.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { readExpansionSites } from "../src/expansion-sites.js";
import { optionViews } from "../src/option-views.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";

/** A document writing `n` independent choices, and one more inside the
 *  `else` of the first. */
function choices(n: number): string {
  const fields = Array.from({ length: n }, (_, i) =>
    [`f${i}: !if`, `  if: !cel "variables.flag${i}"`, `  then: { at: then${i} }`, i === 0 ? "  else: !if" : `  else: { at: else${i} }`]
      .concat(i === 0 ? ['    if: !cel "variables.inner"', "    then: { at: innerThen }", "    else: { at: innerElse }"] : [])
      .join("\n"),
  );
  return ["kind: Telo.Application", "metadata: { name: Views }", "---", "kind: Some.Thing", "metadata: { name: thing }", ...fields].join("\n");
}

describe("the option views of a document", () => {
  it("take every branch it writes, each at its written place, in three views for 2^9 configurations", async () => {
    const loaded = await loadGenerated("option-views.yaml", choices(8));
    const document = loaded.manifests.find((m) => m.kind === "Some.Thing")!;
    const reading = readExpansionSites(loaded.manifests.filter((m) => !isExpansionSentinel(m)), [], new DefinitionRegistry(), undefined, undefined, true);
    const views = optionViews(document, new Map(reading.sites.map((site) => [site.value as object, site])));

    expect(views.length).toBe(3);
    const taken = new Set<string>();
    for (const view of views) {
      for (const [field, value] of Object.entries(view.manifest)) {
        const at = (value as { at?: unknown } | undefined)?.at;
        if (typeof at === "string") taken.add(`${at}@${relocatePath(`${field}.at`, view.mappings)}`);
      }
    }
    expect([...taken].sort()).toEqual(
      [
        "innerElse@f0.else.else.at",
        "innerThen@f0.else.then.at",
        ...Array.from({ length: 8 }, (_, i) => [`then${i}@f${i}.then.at`, ...(i === 0 ? [] : [`else${i}@f${i}.else.at`])]).flat(),
      ].sort(),
    );
  });
});

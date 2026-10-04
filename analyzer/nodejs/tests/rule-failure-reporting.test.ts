import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * An evaluation-time rule failure is ONE diagnostic per (declaring kind, rule
 * code) per analysis, anchored where the reader can act on it.
 *
 * It used to report per SITE: one upstream defect produced 107 diagnostics
 * across 99 lines, every one pointing at a line the reader does not own and
 * cannot fix. A count that grows with the consumer's manifest size for a single
 * defect in someone else's kind is not an actionable error.
 */

const cel = (source: string) => makeTaggedSentinel("cel", source);

const app = {
  kind: "Telo.Application",
  metadata: { name: "App", source: "app.yaml" },
} as unknown as ResourceManifest;

const dependencyImport = {
  kind: "Telo.Import",
  metadata: { name: "Dep", resolvedModuleName: "dep", source: "app.yaml" },
  source: "./dep",
} as unknown as ResourceManifest;

/** A rule whose condition throws on any resource: `widgets` is not declared, so
 *  the unguarded read is a missing key rather than a false verdict. */
const throwingRule = {
  condition: cel("self.widgets.all(w, w > 0)"),
  code: "WIDGETS_POSITIVE",
  message: "lists a widget that is not positive.",
};

const definition = (module: string): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Widget", module, source: `${module}/telo.yaml` },
    capability: "Telo.Runnable",
    controllers: ["pkg:telo/local/js?path=./x.mjs#Widget"],
    schema: {
      type: "object",
      additionalProperties: true,
      "x-telo-resource-rules": [throwingRule],
    },
  }) as unknown as ResourceManifest;

const resources = (count: number, module: string): ResourceManifest[] =>
  Array.from(
    { length: count },
    (_, i) => ({ kind: `${module}.Widget`, metadata: { name: `w${i}` } }) as unknown as ResourceManifest,
  );

const failures = (docs: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(docs))
    .filter((d) => d.code === "RESOURCE_RULE_INVALID")
    .map((d) => ({
      severity: d.severity,
      filePath: (d.data as { filePath?: string } | undefined)?.filePath,
      path: (d.data as { path?: string } | undefined)?.path,
      rule: (d.data as { rule?: string } | undefined)?.rule,
    }));

describe("an evaluation-time rule failure", () => {
  it("is one warning at the consumer's imports entry, however many resources it meets", () => {
    expect(failures([app, dependencyImport, definition("dep"), ...resources(5, "dep")])).toEqual([
      { severity: 2, filePath: "app.yaml", path: "imports.Dep", rule: "WIDGETS_POSITIVE" },
    ]);
  });

  // An ERROR here, unlike the consumer case above: this workspace declares the
  // rule, so the author reading the diagnostic is the one who can fix it. The
  // warning exists only because a consumer cannot change a dependency's rule.
  it("is one error at the rule's own declaration for a kind of this workspace", () => {
    const own = {
      kind: "Telo.Library",
      metadata: { name: "own", source: "own.yaml" },
    } as unknown as ResourceManifest;
    expect(failures([own, definition("own"), ...resources(5, "own")])).toEqual([
      {
        severity: 1,
        filePath: "own/telo.yaml",
        path: "schema.x-telo-resource-rules[0]",
        rule: "WIDGETS_POSITIVE",
      },
    ]);
  });
});

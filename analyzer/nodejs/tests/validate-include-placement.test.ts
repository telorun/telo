import type { ResourceManifest } from "@telorun/sdk";
import { INCLUDE_TEXT_ENGINE, MODULE_PATH_ENGINE, makeTaggedSentinel } from "@telorun/templating";
import { expect, it } from "vitest";
import { validateIncludePlacement } from "../src/validate-include-placement.js";

const judged = (manifest: Record<string, unknown>) =>
  validateIncludePlacement([manifest as unknown as ResourceManifest]).map((d) => [d.code, d.data?.path]);

it("leaves an import's input values and reports a file tag on its other fields", () => {
  expect(
    judged({
      kind: "Telo.Import",
      metadata: { name: "Lib" },
      source: "./lib",
      variables: { root: makeTaggedSentinel(MODULE_PATH_ENGINE, "./a") },
      secrets: { key: makeTaggedSentinel(INCLUDE_TEXT_ENGINE, "key.txt") },
      needs: { store: { path: makeTaggedSentinel(MODULE_PATH_ENGINE, "./data") } },
      runtime: makeTaggedSentinel(INCLUDE_TEXT_ENGINE, "runtime.txt"),
    }),
  ).toEqual([["INCLUDE_OUTSIDE_RESOURCE", "runtime"]]);
});

it("leaves a module document's imports: map to the imports it desugars to", () => {
  expect(
    judged({
      kind: "Telo.Application",
      metadata: { name: "App", description: makeTaggedSentinel(MODULE_PATH_ENGINE, "./x") },
      imports: { Lib: { source: "./lib", variables: { root: makeTaggedSentinel(MODULE_PATH_ENGINE, "./a") } } },
    }),
  ).toEqual([["MODULE_PATH_OUTSIDE_RESOURCE", "metadata.description"]]);
});

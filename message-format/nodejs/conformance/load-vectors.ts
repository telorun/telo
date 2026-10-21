/** Reads the conformance vectors and the CLDR plural data from the checkout, for Node. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VectorSet } from "./vector-runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadVectors(): VectorSet {
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
  return {
    patterns: read("conformance/patterns.json"),
    messages: read("conformance/messages.json"),
    numbers: read("conformance/numbers.json"),
    format: read("conformance/format.json"),
    checks: read("conformance/checks.json"),
    lookup: read("conformance/lookup.json"),
    workingGroup: read("conformance/mf2-working-group/cases.json"),
    plurals: read("cldr/plurals.json"),
  };
}

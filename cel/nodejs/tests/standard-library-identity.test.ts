/**
 * Every call the registry holds, answered identically by both backends.
 *
 * The case list beside this one is written by hand and therefore covers what someone
 * thought of. This one is generated from the registry's own listing — one call per dispatch
 * key, with an argument of each declared parameter type — so a signature added to the
 * library or to the catalog is compared on the day it is added, and a member the emitter
 * dispatches differently cannot hide behind a corpus nobody updated.
 *
 * **It runs over two environments**, because the registry holds two libraries: CEL's own,
 * and the function catalog a host registers beside it. The emitter shipped before the
 * catalog existed, so "every function the registry holds" meant the standard library alone;
 * it now means both, generated from each environment's own listing.
 *
 * **Its filter, and what it cannot reach:**
 *
 * - One call per key, with one sample value per type. A case that passes it and is still
 *   wrong is a call whose answer depends on the *value* rather than the type — `int('12')`
 *   against `int('nope')`, an index inside the string against one past it. Those live in
 *   the conformance replay, which runs every row of cel-spec's corpus and of the catalog's
 *   own rows through both backends; what this gate adds is **coverage of the key set**,
 *   which no corpus guarantees.
 * - A function whose result differs per call (`now`, `uuidv4`, …) is compared by the TYPE
 *   of its answer rather than by the answer, because comparing two calls made a moment
 *   apart would fail for a reason that is not a disagreement. What that cannot see is a
 *   backend answering a different *value* of the right type for one of the nine volatile
 *   functions; each is one call into a host facility with no argument, and the catalog's own
 *   rows pin what each answers through a deterministic expression over its result.
 */
import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/index.js";
import { answerText, emittedPrograms } from "./emitted-host.js";
// One generator, shared with the emitted-text pin: two would be two corpora, and the pin
// would then be over text no identity gate ever compared.
import { callSource, catalogEnvironment, keyOf } from "./registry-calls.js";

const environments = [
  { what: "CEL's own library", environment: new CelEnvironment({ enableOptionalTypes: true }) },
  { what: "CEL's own library and the function catalog", environment: catalogEnvironment() },
];

for (const held of environments) {
  const functions = held.environment.definitions().functions;
  const sources = functions.map(callSource);
  const programs = await emittedPrograms(held.environment, sources);

  describe(`every call the registry holds — ${held.what}`, () => {
    it("is written as one source per dispatch key, and every one reads whole", () => {
      expect(new Set(functions.map(keyOf)).size).toBe(functions.length);
      expect(sources.filter((source) => held.environment.parse(source).diagnostics.length > 0)).toEqual(
        [],
      );
    });

    it("answers identically on both backends", () => {
      const differences: string[] = [];
      for (let at = 0; at < sources.length; at += 1) {
        const closure = answerText(held.environment.compile(sources[at]!));
        const emitted = answerText(programs[at]!);
        if (closure !== emitted) {
          differences.push(`${sources[at]}: closure ${closure}, emitted ${emitted}`);
        }
      }
      expect(differences).toEqual([]);
      const volatile = functions.filter((entry) => !entry.deterministic).length;
      console.log(
        `${sources.length} registry calls compared over ${held.what}, closure against emitted` +
          `${volatile === 0 ? "" : ` (${volatile} volatile ones by the type of the answer)`}`,
      );
    });
  });
}

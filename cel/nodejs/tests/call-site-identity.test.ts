/**
 * A call site answers the same **cold** as it does **warm**.
 *
 * A site resolves its overload on the first call and then holds it, reached by comparing the
 * arguments' type names against the ones it resolved under. So every call has two paths: the
 * resolving one and the monomorphic one, and nothing in the engine compares them — the
 * backend-identity gates run both backends through the *same* site, so a fast path that
 * answered wrongly would be wrong identically on both and every count there would stay green.
 *
 * It exists for the day someone puts a second statement of an operator's meaning on the fast
 * path. With one shared implementation beneath both paths it is nearly vacuous today, and
 * that is the point: it fails on the first run after such a thing is reintroduced.
 *
 * **A compile from TEXT is memoized**, so `compile(source)` twice is one program and one
 * site. Every "fresh site" here is compiled from a parsed tree, which the environment
 * deliberately does not key on — the first draft of this gate compared a program against
 * itself and passed with the guard's type comparison deleted.
 *
 * **Its filter, and what it cannot reach.** The generated calls carry literal arguments, so
 * the types at a generated site never vary and that half alone could not see a guard that
 * ignores the types it resolved under — it would reuse one dispatch for every call and pass.
 * The second half is there for exactly that row: one site driven through several types, each
 * answer held to a fresh site's. What neither reaches is a site whose arguments are of a type
 * no registration declares; that is the conformance replay's territory, where a refusal is a
 * row like any other.
 */
import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/index.js";
import { answerText } from "./emitted-host.js";
import { callSource, catalogEnvironment } from "./registry-calls.js";

const environments = [
  { what: "CEL's own library", environment: new CelEnvironment({ enableOptionalTypes: true }) },
  { what: "CEL's own library and the function catalog", environment: catalogEnvironment() },
];

for (const held of environments) {
  const functions = held.environment.definitions().functions;
  const volatile = new Set(
    functions.filter((entry) => !entry.deterministic).map((entry) => callSource(entry)),
  );
  const sources = functions.map(callSource);

  describe(`every call the registry holds — ${held.what}`, () => {
    it("answers the same cold as warm, and the same as a site that never ran", () => {
      const differences: string[] = [];
      for (const source of sources) {
        // A volatile call answers something new each time by design, so it is held to the
        // TYPE of its answer, exactly as the backend-identity gate holds it.
        const compare = volatile.has(source)
          ? (text: string) => text.slice(0, text.indexOf("(") + 1)
          : (text: string) => text;
        const program = held.environment.compile(held.environment.parse(source));
        const cold = compare(answerText(program));
        const warm = compare(answerText(program));
        const warmer = compare(answerText(program));
        // A site that never ran, for the same call: the resolving path is what it takes.
        const fresh = compare(answerText(held.environment.compile(held.environment.parse(source))));
        if (cold !== warm || warm !== warmer || cold !== fresh) {
          differences.push(`${source}: cold ${cold}, warm ${warm}/${warmer}, fresh site ${fresh}`);
        }
      }
      expect(differences).toEqual([]);
      console.log(`${sources.length} registry calls compared cold against warm over ${held.what}`);
    });
  });
}

/**
 * One site, several argument types. A `dyn` variable is what makes the types vary at a site
 * the way an expression over host data does, which a literal argument never can.
 *
 * **Every case must DISCRIMINATE, and that is asserted rather than assumed.** A case whose
 * types all answer the same thing cannot tell a type-blind guard from a correct one — and a
 * first draft of this gate was built from such cases and passed with the guard's type
 * comparison deleted. `size` over a string and over bytes of the same length is the shape
 * that hid it: both answer `2n`, through different overloads. So each case asserts that its
 * values answer differently from one another before it is allowed to prove anything.
 */
describe("a site whose arguments change type between calls", () => {
  const cases = [
    // A string parse against a numeric conversion: reusing one for the other is an error
    // against a value, not two spellings of one answer.
    { source: "int(subject)", values: ["7", 2.9, 5n] },
    { source: "uint(subject)", values: ["5", 2.7] },
    { source: "double(subject)", values: ["2.5", 7n, true] },
    { source: "timestamp(subject)", values: ["1970-01-01T00:00:01Z", 61n] },
    // Concatenation against addition.
    { source: "subject + subject", values: ["x", 3n, 2.5, [1n]] },
    { source: "string(subject)", values: [2.5, 7n, new Uint8Array([65])] },
    { source: "size(subject)", values: ["abc", [1n, 2n], new Uint8Array([1, 2, 3, 4])] },
    { source: "subject.size()", values: ["ab", [1n, 2n, 3n]] },
  ];

  const environment = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerVariable(
    "subject",
    "dyn",
  );
  /** A program with a site of its own: compiling from a tree is what is not memoized. */
  const freshProgram = (source: string) => environment.compile(environment.parse(source));

  it("is built from cases whose types answer differently, or it proves nothing", () => {
    const weak: string[] = [];
    for (const { source, values } of cases) {
      const answers = values.map((value) =>
        answerText(freshProgram(source), { subject: value }),
      );
      if (new Set(answers).size !== answers.length) weak.push(`${source}: ${answers.join(" | ")}`);
    }
    expect(weak).toEqual([]);
  });

  it("answers each type as a site that never ran would", () => {
    const differences: string[] = [];
    let compared = 0;
    for (const { source, values } of cases) {
      const shared = freshProgram(source);
      for (const value of values) {
        // Twice through the shared site: the second call is the monomorphic path for THIS
        // type, after the site has already resolved under another one.
        const first = answerText(shared, { subject: value });
        const second = answerText(shared, { subject: value });
        const fresh = answerText(freshProgram(source), { subject: value });
        compared += 1;
        if (first !== fresh || second !== fresh) {
          differences.push(`${source} over ${String(value)}: ${first}/${second}, fresh ${fresh}`);
        }
      }
      // And back to the first type, so a site that resolved for the LAST type is caught.
      const again = answerText(shared, { subject: values[0]! });
      const fresh = answerText(freshProgram(source), { subject: values[0]! });
      if (again !== fresh) differences.push(`${source} back to the first type: ${again}, fresh ${fresh}`);
    }
    expect(differences).toEqual([]);
    expect(compared).toBeGreaterThan(20);
  });
});

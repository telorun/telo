/**
 * The two backends answer **identically, case for case** — the same value, or the same
 * error code and the same range.
 *
 * It is not "both pass the corpus". Two backends can each be right about every row a corpus
 * records and still disagree about a form no row writes, and the forms no row writes are
 * exactly the ones Telo's manifests are full of: a comprehension over a host map, a chain
 * into declared state, an optional read whose operand is absent. So the comparison is per
 * case and the canonical text of the answer is what is compared, which makes a difference
 * of CEL type (`1` against `1u`) a difference of text rather than a deep-equality that
 * accepts it.
 *
 * **The filter this gate applies, and the class it cannot reach.** It compares the cases
 * listed here, the 214 calls the registry holds, and every binding form the engine
 * enumerates. A case that passes that filter and is still wrong is a **node kind nothing
 * below writes** — a form of the grammar the corpus simply forgot, which no amount of
 * per-case comparison can notice. That is covered two ways: `NODE_KINDS` below is a
 * `Record` over `CelNode["kind"]`, so adding a node kind to the tree fails to COMPILE until
 * it is listed, and the suite then asserts that the corpus actually reaches every listed
 * kind. The residue is a kind that is reached by some case and whose *interesting* shape is
 * not — an optional index, say, where only a plain one is written — and against that the
 * only instrument is reading the emitter beside the backend, which is why they share every
 * function beneath the tree walk rather than each having their own.
 *
 * The second class it cannot reach is a case where **both** backends are wrong the same
 * way, which is what the conformance replay is for. This gate proves agreement; that one
 * proves the answer.
 */
import { describe, expect, it } from "vitest";
import {
  CEL_VALUE_TYPE,
  CelCompileError,
  CelEnvironment,
  celUint,
  walkTree,
  type CelNode,
  type CelValue,
  type EvaluateOptions,
  type NamespaceDispatch,
} from "../src/index.js";
import { BINDING_FORMS } from "../src/comprehension-bindings.js";
import { answerText, emittedPrograms } from "./emitted-host.js";

/**
 * Every node kind the grammar has. A `Record` over the union rather than a list, so a node
 * kind added to the tree does not compile until someone writes a case for it — the one
 * failure a per-case comparison is blind to by construction.
 */
const NODE_KINDS: Readonly<Record<CelNode["kind"], true>> = {
  literal: true,
  ident: true,
  list: true,
  map: true,
  select: true,
  index: true,
  unary: true,
  binary: true,
  conditional: true,
  call: true,
  receiverCall: true,
  qcall: true,
  unparsed: true,
};

/** The node kinds no case can reach, each with the reason it cannot. */
const UNREACHABLE: Readonly<Partial<Record<CelNode["kind"], string>>> = {
  // A tree with a hole is refused by both backends before anything is emitted, which is
  // asserted below rather than compared as an answer.
  unparsed: "neither backend compiles a tree that did not read whole",
};

function environments(): Record<string, CelEnvironment> {
  const base = new CelEnvironment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });
  return {
    base,
    // A declared dotted name, which both backends must split at COMPILE time and over the
    // same declarations — a chain read through the wrong split is the disagreement
    // `declared-chain.ts` exists to prevent.
    declared: base
      .clone()
      .registerVariable("a.b", "map<string, dyn>")
      .registerVariable("port", "int"),
    namespaced: base.clone().registerNamespace("Billing", ["total(int, int): int", "fail(int): int"]),
    // A host's own implementation: its result is a door a thenable comes through, and a
    // registration with no implementation at all is `unbound_function`.
    hosted: base
      .clone()
      .registerFunction("spend(int): int", { implementation: (ctx, a) => (a as bigint) * 2n })
      .registerFunction("awaited(int): int", { implementation: () => Promise.resolve(1n) as never })
      .registerFunction("nothing(int): int"),
    // A standard signature REPLACED, which is the capability the package exists for: both
    // backends must reach the replacement, and neither the original.
    overridden: base
      .clone()
      .registerFunction("size(string): int", { implementation: () => 99n }),
    // A host's own named type, whose values carry a key of their own: the registered-type
    // case of the member-less values below, which is a value no literal can write.
    branded: base.clone().registerType({ name: "Handle", base: "dyn" }).registerVariable("handle", "Handle"),
  };
}

/**
 * Every value the domain holds that holds **no members at all**, as an expression that
 * builds one. A presence-shaped read over each answers absence and an ordinary one is an
 * error, so the two backends have three forms each to disagree about.
 *
 * It is not `CEL_VALUE_KEYS`: that set names the keys a value may carry, and `type`,
 * `optional`, `map` and `error` are not member-less receivers. These are the scalars, the
 * two instant types, `null` and a host's own named value.
 */
const MEMBER_LESS: readonly string[] = [
  "'abc'",
  "dyn(1)",
  "1u",
  "dyn(1.5)",
  "true",
  "b'ab'",
  "timestamp('2024-01-01T00:00:00Z')",
  "duration('1s')",
  "null",
  "handle",
];

interface Case {
  readonly source: string;
  /** Which environment the case is read and run against. */
  readonly on?: keyof ReturnType<typeof environments>;
  readonly activation?: Record<string, unknown>;
}

const promise = Promise.resolve(1n);

const ACTIVATION: Record<string, unknown> = {
  x: { y: "why", n: 7n, deep: { k: 1n } },
  xs: [1n, 2n, 3n],
  ms: [{ a: 1n }, {}],
  q: "y",
  awaited: { p: promise },
  thenables: [promise, 2n],
  held: { [CEL_VALUE_TYPE]: "optional", present: true, held: promise },
  "a.b": { c: 5n },
  "a.b.c": 9n,
  port: 8080n,
  dashed: { "content-type": "text/plain" },
  typed: celUint(3n),
  // A value of a host's own named type: a key outside the engine's own set, so the seam
  // finds no member on it however the read is written.
  handle: { [CEL_VALUE_TYPE]: "Handle" },
};

/**
 * The namespaced dispatch, bound for every case: one function that answers, one that hands
 * back a value that must be awaited, and nothing at all under a third name.
 */
const namespaceFunction: NamespaceDispatch = (namespace, name) => {
  if (namespace !== "Billing") return undefined;
  if (name === "total") return (args) => (args[0] as bigint) + (args[1] as bigint);
  if (name === "fail") return () => promise as never;
  return undefined;
};

const OPTIONS: EvaluateOptions = { namespaceFunction };

const CASES: readonly Case[] = [
  // literals, every type the grammar reads
  { source: "1" },
  { source: "-9223372036854775808" },
  { source: "7u" },
  { source: "1.5" },
  { source: "-0.0" },
  { source: "1e400" },
  { source: "0.0/0.0" },
  { source: "'a\\u00ffb'" },
  { source: "b'\\xff\\x00ab'" },
  { source: "true" },
  { source: "null" },

  // names and the library's own constants
  { source: "x" },
  { source: "missing" },
  { source: "int" },
  { source: "google.protobuf.Timestamp" },
  { source: "type(1) == int" },

  // dotted chains: declared, declared at the root only, and searched
  { source: "a.b.c", on: "declared" },
  { source: "a.b.c" },
  { source: "port + 1", on: "declared" },
  { source: "x.deep.k" },
  { source: "x.y.z" },
  { source: ".x.y" },

  // member reads, every form
  { source: "x.y" },
  { source: "x.?y" },
  { source: "x.?nope" },
  { source: "x['y']" },
  { source: "x[q]" },
  { source: "x[?'nope']" },
  { source: "xs[1]" },
  { source: "xs[9]" },
  { source: "xs[?9]" },
  { source: "dashed.`content-type`" },
  { source: "x.nope" },
  { source: "1.nope" },
  { source: "has(x.y)" },
  { source: "has(x.nope)" },
  { source: "has(x.?y.z)" },

  // a presence-shaped read over each member-less value, in all three forms — absence; the
  // ordinary read of the same member, and an unusable key in the presence form — an error
  ...MEMBER_LESS.flatMap((value): readonly Case[] => [
    { source: `${value}.?nope`, on: "branded" },
    { source: `${value}[?'nope']`, on: "branded" },
    { source: `has(${value}.nope)`, on: "branded" },
    { source: `${value}.nope`, on: "branded" },
  ]),
  { source: "xs.?nope" },
  { source: "optional.none().?nope" },
  { source: "optional.of('abc').?nope" },
  { source: "optional.of('abc').nope" },
  { source: "has(optional.of('abc').nope)" },
  // the two places a backend has historically answered differently: an aggregate's `?`
  // entry, and a comprehension body
  { source: "[?'abc'.?nope, 1]" },
  { source: "{?'k': 'abc'.?nope, 'j': 2}" },
  { source: "['abc', {'nope': 1}].map(e, has(e.nope))" },
  { source: "['abc', {'nope': 1}].filter(e, e.?nope.hasValue())" },

  // aggregates
  { source: "[]" },
  { source: "[1, 2, 3]" },
  { source: "[1, 'a', [2]]" },
  { source: "[?optional.of(1), 2, ?optional.none()]" },
  { source: "[?1]" },
  { source: "[x.nope, 1]" },
  { source: "{}" },
  { source: "{'a': 1, 'b': 2}" },
  { source: "{1: 'a', 1u: 'b'}" },
  { source: "{'a': x.nope}" },
  { source: "{x.nope: 1}" },
  { source: "{?'k': optional.none(), 'j': 2}" },
  { source: "{?'k': 1}" },
  { source: "{1.5: 'a'}" },

  // operators, and the short circuit from either side
  { source: "1 + 2" },
  { source: "9223372036854775807 + 1" },
  { source: "1 / 0" },
  { source: "'a' + 'b'" },
  { source: "!(true)" },
  { source: "-(x.n)" },
  { source: "false && x.nope == 1" },
  { source: "x.nope == 1 && false" },
  { source: "true || x.nope == 1" },
  { source: "x.nope == 1 || true" },
  { source: "true && x.nope == 1" },
  { source: "1 && true" },
  { source: "dyn(1) == 1u" },
  { source: "dyn(9223372036854775807) < 9223372036854775808.0" },
  { source: "1 in xs" },
  { source: "'a' in {'a': 1}" },

  // the conditional
  { source: "x.y == 'why' ? 1 : 2" },
  { source: "x.nope ? 1 : 2" },
  { source: "1 ? 1 : 2" },
  { source: "true ? x.nope : 2" },

  // calls, in both forms
  { source: "size('ab')" },
  { source: "size('ab')", on: "overridden" },
  { source: "'ab'.size()" },
  { source: "'ab'.startsWith('a')" },
  { source: "int('nope')" },
  { source: "duration('90s') + duration('1.5s')" },
  { source: "timestamp('2024-03-04T05:06:07.008009010Z').getHours('Europe/Warsaw')" },
  { source: "string(timestamp('2024-03-04T05:06:07.008009010Z'))" },
  { source: "'ab'.nope()" },
  { source: "nope(1)" },
  { source: "spend(21)", on: "hosted" },
  { source: "awaited(1)", on: "hosted" },
  { source: "nothing(1)", on: "hosted" },

  // namespaced calls
  { source: "Billing.total(2, 3) + 1", on: "namespaced" },
  { source: "Billing.fail(1)", on: "namespaced" },
  { source: "Billing.total(x.nope, 3)", on: "namespaced" },
  { source: "Billing.nothing(1)", on: "namespaced" },

  // comprehensions, every macro and both arities of `map`
  { source: "xs.all(e, e > 0)" },
  { source: "xs.all(e, e > 1)" },
  { source: "xs.exists(e, e == 2)" },
  { source: "xs.exists_one(e, e == 2)" },
  { source: "xs.filter(e, e > 1)" },
  { source: "xs.map(e, e * 2)" },
  { source: "xs.map(e, e > 1, e * 2)" },
  { source: "ms.exists(e, e.a == 1)" },
  { source: "ms.all(e, e.a == 1)" },
  { source: "x.map(k, k)" },
  { source: "1.map(e, e)" },
  { source: "xs.map(e, xs.map(f, e * f))" },
  { source: "xs.map(e, 1)" },

  // bindings, and a binding whose name shadows one around it
  { source: "cel.bind(n, 2, n * n)" },
  { source: "cel.bind(n, x.nope, 1)" },
  { source: "cel.bind(n, 2, xs.map(n, n + 1))" },
  { source: "cel.bind(n, 2, cel.bind(n, 3, n))" },
  // A body function capturing a name bound by the function AROUND it, and the reverse: the
  // emitter gives each body its own temporaries for exactly this, because a body outlives the
  // expression that called it and sharing a name with its caller would clobber a live value.
  { source: "cel.bind(n, 2, xs.map(e, e + n))" },
  { source: "xs.map(e, cel.bind(n, e, n + 1))" },
  { source: "xs.all(e, has(x.y) && e > 0)" },
  { source: "xs.map(e, xs[0] + e)" },
  { source: "xs.filter(e, e in xs)" },
  { source: "optional.of(xs).optMap(v, v[0])" },
  { source: "xs.map(e, e > 1 ? (e > 2 ? 'c' : 'b') : 'a')" },

  // the optional library
  { source: "optional.of(1).value()" },
  { source: "optional.none().value()" },
  { source: "optional.ofNonZeroValue(0)" },
  { source: "optional.ofNonZeroValue(1)" },
  { source: "optional.none().orValue(7)" },
  { source: "optional.of(1).or(optional.of(2))" },
  { source: "optional.of(1).hasValue()" },
  { source: "optional.of(2).optMap(v, v * 2)" },
  { source: "optional.none().optMap(v, v * 2)" },
  { source: "optional.of(2).optFlatMap(v, optional.of(v))" },
  { source: "optional.of(2).optFlatMap(v, v)" },
  { source: "1.optMap(v, v)" },

  // every door a value that must be awaited comes through
  { source: "awaited.p" },
  { source: "[awaited.p]" },
  { source: "{'k': awaited.p}" },
  { source: "thenables[0]" },
  { source: "size(thenables)" },
  { source: "1 in thenables" },
  { source: "thenables.all(e, true)" },
  { source: "thenables.all(e, e == e)" },
  { source: "thenables.exists(e, true)" },
  { source: "thenables.exists(e, false)" },
  { source: "thenables.exists_one(e, true)" },
  { source: "thenables.filter(e, true)" },
  { source: "thenables.map(e, e)" },
  { source: "thenables.map(e, true, e)" },
  { source: "held.optMap(v, v)" },
  { source: "held.optFlatMap(v, optional.of(v))" },
  { source: "cel.bind(v, awaited.p, 1)" },
  { source: "typed + 1u" },
];

const SOURCES = environments();

/** The cases of one environment, in the order they are written. */
function casesOn(name: string): readonly Case[] {
  return CASES.filter((held) => (held.on ?? "base") === name);
}

const prepared = await Promise.all(
  Object.keys(SOURCES).map(async (name) => {
    const environment = SOURCES[name]!;
    const cases = casesOn(name);
    const programs = await emittedPrograms(
      environment,
      cases.map((held) => held.source),
    );
    return { name, environment, cases, programs };
  }),
);

describe("the emitter and the closure backend answer identically", () => {
  for (const group of prepared) {
    it(`answers every case of the ${group.name} environment the same way`, () => {
      const differences: string[] = [];
      for (let at = 0; at < group.cases.length; at += 1) {
        const held = group.cases[at]!;
        const activation = (held.activation ?? ACTIVATION) as Record<string, CelValue>;
        const closure = answerText(group.environment.compile(held.source), activation, OPTIONS);
        const emitted = answerText(group.programs[at]!, activation, OPTIONS);
        if (closure !== emitted) {
          differences.push(`${held.source}: closure ${closure}, emitted ${emitted}`);
        }
      }
      expect(differences).toEqual([]);
    });
  }

  it("compares a case for every node kind the grammar has", () => {
    const reached = new Set<string>();
    for (const group of prepared) {
      for (const held of group.cases) {
        for (const node of walkTree(group.environment.parse(held.source).root)) {
          reached.add(node.kind);
        }
      }
    }
    const missing = Object.keys(NODE_KINDS).filter(
      (kind) => !reached.has(kind) && !(kind in UNREACHABLE),
    );
    expect(missing).toEqual([]);
    for (const [kind, why] of Object.entries(UNREACHABLE)) {
      expect(why.length, kind).toBeGreaterThan(20);
    }
  });

  it("refuses the same trees at compile, with the same message", () => {
    const refused = ["has(1)", "1 +", "optional.of()", "xs.map(1, 1)"];
    for (const source of refused) {
      const environment = SOURCES.base!;
      const closure = refusal(() => environment.compile(source));
      const emitted = refusal(() => environment.emit([source]));
      expect(emitted, source).toBe(closure);
      expect(closure, source).not.toBe("it compiled");
    }
  });

  it("probes every form that binds a value into a body, on both backends", () => {
    // **Closed by the engine's own enumeration**, not by the cases someone tried: a tenth
    // binding form cannot be added without failing here, and each probe is written so no
    // readable element can decide the answer.
    const probes: Readonly<Record<string, string>> = {
      "all/2": "thenables.all(e, true)",
      "exists/2": "thenables.exists(e, false)",
      "exists_one/2": "thenables.exists_one(e, true)",
      "filter/2": "thenables.filter(e, true)",
      "map/2": "thenables.map(e, e)",
      "map/3": "thenables.map(e, true, e)",
      "optMap/2": "held.optMap(v, v)",
      "optFlatMap/2": "held.optFlatMap(v, optional.of(v))",
      "cel.bind/3": "cel.bind(v, awaited.p, 1)",
    };
    expect(Object.keys(probes).sort()).toEqual([...BINDING_FORMS].sort());
    const environment = SOURCES.base!;
    for (const [form, source] of Object.entries(probes)) {
      const closure = answerText(environment.compile(source), ACTIVATION as Record<string, CelValue>);
      expect(closure, form).toMatch(/^error async_value_unsupported/);
      expect(CASES.some((held) => held.source === source), form).toBe(true);
    }
  });
});

function refusal(run: () => unknown): string {
  try {
    run();
    return "it compiled";
  } catch (cause) {
    return cause instanceof CelCompileError
      ? `CelCompileError: ${cause.message}`
      : `${(cause as Error).name}: ${(cause as Error).message}`;
  }
}

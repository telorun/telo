/**
 * The corpus the emitted TEXT is pinned over, drawn from the enumerations this package
 * already holds total.
 *
 * `EMITTER_FORMAT_GENERATION` is bumped on **any** change to the text the emitter writes for
 * any tree, and that rule needs an instrument or it is a promise. So: one expression per
 * `CelNode["kind"]`, one probe per `BINDING_FORMS` entry, one call per dispatch key the
 * registry holds — each list total by construction, the first by a `Record` over the union
 * that does not compile when a node kind is added, the other two read from the data.
 *
 * **One group is hand-written, and that is where this corpus can be incomplete.** Several
 * branches of the emitter are not distinguished by any enumeration: which way a dotted chain
 * splits, the optional form of a read, the two arities of `map`. They are written out below
 * under their own heading, so the gap is a list someone can read rather than a silence.
 */

import { BINDING_FORMS } from "../src/comprehension-bindings.js";
import type { CelEnvironment, CelNode } from "../src/index.js";
import { callSource, catalogEnvironment } from "./registry-calls.js";

/**
 * One expression per node kind. A `Record` over the union, so a node kind added to the tree
 * does not compile until an expression writes it; `unparsed` is `null` because neither
 * backend compiles a tree with a hole, which is asserted where the two are compared.
 */
export const NODE_KIND_EXPRESSIONS: Readonly<Record<CelNode["kind"], string | null>> = {
  literal: "1",
  ident: "x",
  list: "[1, 2, 3]",
  map: "{'a': 1, 'b': 2}",
  select: "x.y",
  index: "xs[1]",
  unary: "!(true)",
  binary: "1 + 2",
  conditional: "x.y == 1 ? 1 : 2",
  call: "has(x.y)",
  receiverCall: "'ab'.startsWith('a')",
  qcall: "Billing.total(1, 2)",
  unparsed: null,
};

/** One probe per form that binds a value into a body, keyed as the table keys them. */
const BINDING_PROBES: Readonly<Record<string, string>> = {
  "all/2": "xs.all(e, e > 0)",
  "exists/2": "xs.exists(e, e > 0)",
  "exists_one/2": "xs.exists_one(e, e > 0)",
  "filter/2": "xs.filter(e, e > 0)",
  "map/2": "xs.map(e, e * 2)",
  "map/3": "xs.map(e, e > 1, e * 2)",
  "optMap/2": "optional.of(1).optMap(v, v + 1)",
  "optFlatMap/2": "optional.of(1).optFlatMap(v, optional.of(v))",
  "cel.bind/3": "cel.bind(n, 2, n * n)",
};

/**
 * Branches of the emitter no enumeration names. **This is the hand-written group**, and the
 * one part of the corpus that can be incomplete: each entry is a decision the emitter makes
 * about a tree whose node kinds are already covered above.
 */
const UNENUMERATED_SHAPES: readonly string[] = [
  // Which way a dotted chain splits — over the names the host declared, at emit time.
  "a.b.c",
  "declared.deep.leaf",
  "undeclared.deep.leaf",
  // A name a body bound, read through a chain rooted at it rather than through the activation.
  "xs.map(e, cel.bind(n, e, n + 1))",
  "cel.bind(n, 2, xs.map(e, e + n))",
  // The optional form of every read, and an optional entry in each aggregate.
  "x.?y",
  "x[?'y']",
  "[?optional.of(1), 2]",
  "{?'k': optional.none(), 'j': 2}",
  // Every literal the emitter writes differently from its neighbours.
  "-9223372036854775808",
  "7u",
  "-0.0",
  "b'\\xff\\x00'",
  "'a\\u00ffb'",
  "null",
  // Both short-circuit operators, which are the one pair the emitter writes by hand.
  "false && x.nope",
  "true || x.nope",
  // A namespaced call with no arguments, and one the activation decides nothing about.
  "Billing.ping()",
  // An absolute name, and a backtick-quoted member.
  ".x.y",
  "dashed.`content-type`",
];

/** The environment the pinned corpus is emitted against. */
export function emitterTextEnvironment(): CelEnvironment {
  return catalogEnvironment({ unlistedVariablesAreDyn: true })
    .registerNamespace("Billing", ["total(int, int): int", "ping(): int"])
    .registerVariable("a.b", "map<string, dyn>")
    .registerVariable("declared", "map<string, dyn>");
}

/**
 * The corpus, in one deterministic order: the node kinds in the `Record`'s own key order,
 * the binding forms in the table's, the unenumerated shapes as written, then one call per
 * dispatch key in the listing's order.
 */
export function emitterTextCorpus(environment: CelEnvironment): readonly string[] {
  const kinds = Object.values(NODE_KIND_EXPRESSIONS).filter((held): held is string => held !== null);
  const bindings = BINDING_FORMS.map((form) => {
    const held = BINDING_PROBES[form];
    if (held === undefined) throw new Error(`no probe for the binding form ${form}`);
    return held;
  });
  const calls = environment.definitions().functions.map(callSource);
  return [...kinds, ...bindings, ...UNENUMERATED_SHAPES, ...calls];
}

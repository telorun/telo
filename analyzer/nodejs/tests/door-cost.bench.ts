import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { assignmentKey } from "../src/configuration-dimensions.js";
import { observeAnalysisRuns, observeKeyCosts } from "../src/cel-site-judgements.js";
import {
  costApplication,
  crossedReferentPadding,
  flagSequence,
  flagSequenceInTry,
  flagTargets,
  forwardChain,
  forwardedSequence,
  forwardedSequenceNested,
  inlineDeclarations,
  inlineSequence,
  loadGenerated,
  nameReadPadding,
  rulePadding,
  catalogSetPadding,
  zonePadding,
  referentPadding,
  relationPadding,
  scopePadding,
} from "./configuration-cost-fixtures.js";

/**
 * What building the keys' environments costs, read off the analysis's counters
 * and printed once per row beside the timing:
 *
 *  - `padding`: fixture V at N=2 with P = 0, 100 and 1000 declarations no
 *    configuration varies, each holding an expression of its own (one key
 *    each). A key's environment is built from what its classes cover, so the
 *    time per key stays flat in P and the total grows linearly.
 *  - `unread`: fixture V at N=2 with P = 0, 100 and 1000 declared variables no
 *    expression reads. A key reads its module's inputs as the module's shared
 *    globals base plus the entries its classes narrow, so the nodes per CEL and
 *    schema key and the time per key stay flat in P.
 *  - `V` at N = 1, 2, 4, 8 and the configuration-cost application (`isolated`
 *    and `reached`) at none, 1, 2 and 4 configurations: shared setups, door environments,
 *    keys, own-check keys, `scopeFor` calls, typed CEL environments built (each a distinct
 *    content, at most one per key) and declarations normalized (an invariant
 *    one once per distinct outcome of the references it stamps); of the
 *    own-check keys, the relation sites' (each site's most keys, the most and
 *    total nodes a key's environment holds of its declaration, and the nodes
 *    region normalizations built) and the rest.
 *
 *  - `W` (V's steps inside one `try:` step), `S`, `T` (V's steps forwarded
 *    through a templated kind), `Tn-inline` (T's consumer written inline as
 *    the target of a sequence `holder`'s one step, the holder declaring no
 *    `with:`), `Tn-with` (T's consumer as `holder`'s `with:` member), `Ti`
 *    (V's sequence written inline as the target of `holder`'s one step) and
 *    `Ti-choice` (that target a choice on `flag0` between the inline sequence
 *    and a reference) at the same N:
 *    the schema own-check keys (each site's most, and the most at a site of
 *    the Application, whose region names the sequence), the most nodes a CEL
 *    key's and a schema key's environment normalized — overall, at the sites
 *    of the declaration named `sequence` (T's are written in `wrapped`, whose
 *    steps the sequence's view holds, and Tn's in `holder`), and summed over
 *    the keys — and the
 *    POST-LOOP time —
 *    `analyze()` less the time inside configuration and unreachable-branch
 *    runs.
 *    Beside a schema key's nodes, its OWN EXTENT, counted from the union as
 *    written (the declaration's identity, the way to the region with what each
 *    object on it holds beside it, the region with each carve one node; module
 *    inputs never), and how many keys' nodes differ from it, by how much. The
 *    same beside a CEL key's nodes, its regions the site, the places it reads
 *    beyond it and the step objects it reads, each step expression another
 *    key types one carved node, its stand-in carrying that key's fact (a key
 *    judged on its declaration whole — a template body's or a kind
 *    document's — has none). A key's nodes are compared with its own extent
 *    plus the read extent of the declarations it reaches by name.
 *  - The DOOR counter, per family (CEL, schema, relation): the nodes a key's
 *    door normalizes — every declaration it holds whole beside the shared
 *    layer and every region, a declaration reached by name counted by the
 *    regions it holds of it — the most per key and in all, of them those of
 *    declarations reached by name, and how many keys' by-name nodes differ
 *    from those regions' extent counted from the union as written — and
 *    `whole by name`: the declarations reached by name a key's door normalized
 *    whole that are no named shape, with the readers holding them so.
 *  - Reads into another site's region: the places schema keys read beyond
 *    their region that a sibling site or a carved sub-site holds, or that hold
 *    a carved sub-site — which no key reads.
 *  - For V and W, the relation sites of the declaration named `sequence`: the
 *    most keys and nodes a key of one holds, and at the site anchored at its
 *    first step (W's `try:` step, whose key carves the steps nested in it).
 *  - `F` (a chain of k = 8, 16, 32 steps each forwarding the result before
 *    it): the same counters. A forward is carved where it is read, so a CEL
 *    key's nodes stay its own extent whatever k is and the extents grow
 *    linearly in k.
 *  - `K` (a sequence of k = 1, 4, 16 steps, each invoking an inline
 *    declaration under a choice of its own), one configuration kept: the
 *    enumerations settling which objects are declarations of their own, and
 *    the time settling and cutting take. One enumeration serves every
 *    candidate a configuration takes, so both stay linear in k.
 *
 *  - `crossed padding`: `mergedPlaceViews()`'s exact forward through a
 *    reference alone, each referent padded with P = 0, 100 and 1000 steps
 *    under a field nothing forwards: per family, the door counter over the
 *    keys of the consumer and of its views, and their door time per key. A key
 *    reading across the reference holds the referent only as the regions it
 *    reads, so both stay flat in P.
 *  - `name-read padding`: declarations a sequence reads by name — through
 *    `resources.<name>.<field>`, a bare `resources[…]` and a module call — each
 *    padded with P = 0, 100 and 1000 entries nothing reads: per family, the
 *    door counter over the reader's keys and their door time per key. A read
 *    by name holds each declaration as the places its reading is typed from,
 *    so both stay flat in P.
 *  - `reference-read padding`: an annotation reading through a reference — a
 *    resource rule's `resolve:` past a slot (keys of `form`), a text catalog
 *    set reaching another's (`set`), a zone requirement whose key crosses a
 *    reference (`work`) — each declaration it reads there padded with P = 0,
 *    100 and 1000 entries nothing reads: per family, the door counter over the
 *    reader's keys and their door time per key. Such a read holds each
 *    declaration as the places its reader reads in it, so both stay flat in P.
 *  - `varying-referent padding`: one declaration holding a member a flag
 *    varies, padded with P = 0, 100 and 1000 entries nothing reads, read by
 *    every annotation that reads a reference one hop — a boot target
 *    (`x-telo-ref`, keys of the Application), a region typed from a handler's
 *    output (`x-telo-context-ref-from`, `caller`), a slot typed from the type
 *    it declares (`x-telo-schema-from`, `shaped`), a scope a step names it in
 *    (`x-telo-scope`, `scoped`), a function's `returns` (`x-telo-returns-from`,
 *    `measure`) — and as the referrer whose scope types an accessor binding
 *    (`x-telo-context-from-referrer`, `field`): per reader and family, the door
 *    counter over its keys and their door time per key. Each read holds the
 *    declaration as its identity and the places its reader names in it, so
 *    both stay flat in P.
 *  - `scope padding`: a sequence whose `with:` scope holds a member nothing
 *    outside it reads, holding P = 0, 4 and 8 steps each choosing on its own
 *    flag: per family, the keys and door nodes of the sequence's sites outside
 *    that member. A region holds a scope on the way only as its members'
 *    identities, so both stay constant in P.
 *  - `within`: V and S at N = 4 and 8, narrowed to each configuration in turn:
 *    the most keys a kept configuration holds at one site (per family, union
 *    place and template variant), the declarations present at such a key's
 *    witness that the kept configuration varies and those normalized for it,
 *    and the analysis time — the first configuration's, and the most. Narrowed
 *    to one configuration nothing varies, so every site holds one key and no
 *    door holds or normalizes a varying declaration.
 *
 * Run: `npx vitest bench --run tests/door-cost.bench.ts`; `DOOR_COST_V=1,2,4`
 * picks the V and W rows (N=8 is 256 configuration runs).
 */

const V = (process.env.DOOR_COST_V ?? "1,2,3,4,8").split(",").map(Number);

interface Counted {
  setups: number;
  doors: number;
  owns: number;
  scopes: number;
  environments: number;
  normalizations: number;
  invariant: number;
  invariantPairs: number;
  doorMs: number;
  relationKeys: number;
  relationSites: number;
  keysPerSite: number;
  nodesPerKey: number;
  relationNodes: number;
  regionNodes: number;
  schemaKeys: number;
  schemaSites: number;
  schemaKeysPerSite: number;
  applicationSchemaKeys: number;
  celNodesPerKey: number;
  schemaNodesPerKey: number;
  celNodes: number;
  schemaNodes: number;
  sequenceCelNodesPerKey: number;
  sequenceSchemaNodesPerKey: number;
  schemaExtentPerKey: number;
  sequenceSchemaExtentPerKey: number;
  schemaExtents: number;
  schemaKeysOverExtent: number;
  schemaOverExtent: number;
  sequenceSchemaOverExtent: number;
  celExtentPerKey: number;
  sequenceCelExtentPerKey: number;
  celExtents: number;
  celKeysOverExtent: number;
  celOverExtent: number;
  sequenceCelOverExtent: number;
  celKeysWithoutExtent: number;
  applicationSchemaNodes: number;
  applicationSchemaExtent: number;
  sequenceKeysPerSite: number;
  sequenceNodesPerKey: number;
  firstStepKeys: number;
  firstStepNodes: number;
  carveReads: number;
  /** The door counter, per family: the most nodes a key's door normalized,
   *  those in all, of them the nodes of declarations reached by name, and the
   *  keys whose by-name nodes differ from those declarations' read extent. */
  door: Record<Family, { perKey: number; total: number; byName: number; byNameOff: number; whole: number; wholeReads: Set<string> }>;
  totalMs: number;
  loopMs: number;
}

type Family = "cel" | "schema" | "relation";
const FAMILIES: readonly Family[] = ["cel", "schema", "relation"];

/** Whether a relation site id is anchored in the declaration named `sequence`,
 *  and at its first step. */
function sequenceSite(site: string): { sequence: boolean; firstStep: boolean } {
  const id = JSON.parse(site) as unknown[];
  const sequence = id[0] === "relation" && id[3] === "sequence";
  return { sequence, firstStep: sequence && id[5] === "steps[0]" };
}

/** Whether a CEL or schema site id names the declaration `name`. */
function declaredIn(site: string, name: string): boolean {
  return (JSON.parse(site) as unknown[])[1] === name;
}

/** Whether a site of any family — a relation site's included, a forward view's
 *  named `<declaration>→<entry>` — is one of the declaration `name`. */
function ofDeclaration(site: string, name: string): boolean {
  const id = JSON.parse(site) as unknown[];
  return id[1] === name || (id[0] === "relation" && (id[3] === name || (typeof id[3] === "string" && id[3].startsWith(`${name}→`))));
}

function counted(run: () => void, sequenceName = "sequence"): Counted {
  const out: Counted = {
    setups: 0,
    doors: 0,
    owns: 0,
    scopes: 0,
    environments: 0,
    normalizations: 0,
    invariant: 0,
    invariantPairs: 0,
    doorMs: 0,
    relationKeys: 0,
    relationSites: 0,
    keysPerSite: 0,
    nodesPerKey: 0,
    relationNodes: 0,
    regionNodes: 0,
    schemaKeys: 0,
    schemaSites: 0,
    schemaKeysPerSite: 0,
    applicationSchemaKeys: 0,
    celNodesPerKey: 0,
    schemaNodesPerKey: 0,
    celNodes: 0,
    schemaNodes: 0,
    sequenceCelNodesPerKey: 0,
    sequenceSchemaNodesPerKey: 0,
    schemaExtentPerKey: 0,
    sequenceSchemaExtentPerKey: 0,
    schemaExtents: 0,
    schemaKeysOverExtent: 0,
    schemaOverExtent: 0,
    sequenceSchemaOverExtent: 0,
    celExtentPerKey: 0,
    sequenceCelExtentPerKey: 0,
    celExtents: 0,
    celKeysOverExtent: 0,
    celOverExtent: 0,
    sequenceCelOverExtent: 0,
    celKeysWithoutExtent: 0,
    applicationSchemaNodes: 0,
    applicationSchemaExtent: 0,
    sequenceKeysPerSite: 0,
    sequenceNodesPerKey: 0,
    firstStepKeys: 0,
    firstStepNodes: 0,
    carveReads: 0,
    door: {
      cel: { perKey: 0, total: 0, byName: 0, byNameOff: 0, whole: 0, wholeReads: new Set() },
      schema: { perKey: 0, total: 0, byName: 0, byNameOff: 0, whole: 0, wholeReads: new Set() },
      relation: { perKey: 0, total: 0, byName: 0, byNameOff: 0, whole: 0, wholeReads: new Set() },
    },
    totalMs: 0,
    loopMs: 0,
  };
  /** The by-name extent of the key whose door was last built, by site. */
  const byNameExtents = new Map<string, number>();
  const keysBySite = new Map<string, number>();
  const schemaKeysBySite = new Map<string, number>();
  const pairs = new Map<object, Set<string>>();
  const extents = new Map<string, number>();
  const celExtents = new Map<string, number>();
  const stopRuns = observeAnalysisRuns((purpose) => {
    if (purpose === "setup") out.setups++;
    else if (purpose === "own") out.owns++;
  });
  const stopCosts = observeKeyCosts((cost) => {
    if (cost.kind === "scope") out.scopes++;
    else if (cost.kind === "typed-environment") out.environments++;
    else if (cost.kind === "relation") {
      out.relationKeys++;
      keysBySite.set(cost.site, (keysBySite.get(cost.site) ?? 0) + 1);
      out.nodesPerKey = Math.max(out.nodesPerKey, cost.nodes);
      out.relationNodes += cost.nodes;
      const { sequence, firstStep } = sequenceSite(cost.site);
      if (sequence) out.sequenceNodesPerKey = Math.max(out.sequenceNodesPerKey, cost.nodes);
      if (firstStep) out.firstStepNodes = Math.max(out.firstStepNodes, cost.nodes);
    } else if (cost.kind === "schema-extent") extents.set(cost.site, cost.nodes);
    else if (cost.kind === "carve-read") out.carveReads++;
    else if (cost.kind === "cel-extent") celExtents.set(cost.site, cost.nodes);
    else if (cost.kind === "door-nodes") {
      const door = out.door[cost.family];
      door.perKey = Math.max(door.perKey, cost.nodes);
      door.total += cost.nodes;
      door.byName += cost.byNameNodes;
      if (cost.byNameNodes !== cost.byNameExtent) door.byNameOff++;
      door.whole += cost.wholeByName;
      for (const read of cost.wholeByNameReads) door.wholeReads.add(read.slice(0, read.indexOf(":")));
      byNameExtents.set(cost.site, cost.byNameExtent);
    }
    else if (cost.kind === "schema") {
      out.schemaKeys++;
      schemaKeysBySite.set(cost.site, (schemaKeysBySite.get(cost.site) ?? 0) + 1);
      out.schemaNodesPerKey = Math.max(out.schemaNodesPerKey, cost.nodes);
      out.schemaNodes += cost.nodes;
      const extent = extents.get(cost.site);
      if (extent === undefined) throw new Error(`no own extent was reported for schema site ${cost.site}`);
      extents.delete(cost.site);
      const over = cost.nodes - extent - (byNameExtents.get(cost.site) ?? 0);
      out.schemaExtentPerKey = Math.max(out.schemaExtentPerKey, extent);
      out.schemaExtents += extent;
      if (over !== 0) out.schemaKeysOverExtent++;
      out.schemaOverExtent = Math.max(out.schemaOverExtent, over);
      if (declaredIn(cost.site, sequenceName)) {
        out.sequenceSchemaNodesPerKey = Math.max(out.sequenceSchemaNodesPerKey, cost.nodes);
        out.sequenceSchemaExtentPerKey = Math.max(out.sequenceSchemaExtentPerKey, extent);
        out.sequenceSchemaOverExtent = Math.max(out.sequenceSchemaOverExtent, over);
      }
      if ((JSON.parse(cost.site) as unknown[])[0] === "Telo.Application") {
        out.applicationSchemaNodes = Math.max(out.applicationSchemaNodes, cost.nodes);
        out.applicationSchemaExtent = Math.max(out.applicationSchemaExtent, extent);
      }
    } else if (cost.kind === "cel") {
      out.celNodesPerKey = Math.max(out.celNodesPerKey, cost.nodes);
      out.celNodes += cost.nodes;
      if (declaredIn(cost.site, sequenceName)) out.sequenceCelNodesPerKey = Math.max(out.sequenceCelNodesPerKey, cost.nodes);
      const extent = celExtents.get(cost.site);
      celExtents.delete(cost.site);
      if (extent === undefined) out.celKeysWithoutExtent++;
      else {
        const over = cost.nodes - extent - (byNameExtents.get(cost.site) ?? 0);
        out.celExtentPerKey = Math.max(out.celExtentPerKey, extent);
        out.celExtents += extent;
        if (over !== 0) out.celKeysOverExtent++;
        out.celOverExtent = Math.max(out.celOverExtent, over);
        if (declaredIn(cost.site, sequenceName)) {
          out.sequenceCelExtentPerKey = Math.max(out.sequenceCelExtentPerKey, extent);
          out.sequenceCelOverExtent = Math.max(out.sequenceCelOverExtent, over);
        }
      }
    }
    else if (cost.kind === "run") {
      if (cost.purpose === "configuration" || cost.purpose === "unreachable") out.loopMs += cost.milliseconds;
    } else if (cost.kind === "region") out.regionNodes += cost.nodes;
    else if (cost.kind === "door" && cost.family === "cel") {
      out.doors++;
      out.doorMs += cost.milliseconds;
    } else if (cost.kind === "normalization") {
      out.normalizations++;
      if (!cost.invariant) return;
      out.invariant++;
      let seen = pairs.get(cost.declaration);
      if (!seen) pairs.set(cost.declaration, (seen = new Set()));
      seen.add(cost.outcomes);
    }
  });
  const started = performance.now();
  try {
    run();
  } finally {
    out.totalMs = performance.now() - started;
    stopRuns();
    stopCosts();
  }
  out.invariantPairs = [...pairs.values()].reduce((n, seen) => n + seen.size, 0);
  out.relationSites = keysBySite.size;
  out.keysPerSite = Math.max(0, ...keysBySite.values());
  out.schemaSites = schemaKeysBySite.size;
  out.schemaKeysPerSite = Math.max(0, ...schemaKeysBySite.values());
  for (const [site, keys] of keysBySite) {
    const { sequence, firstStep } = sequenceSite(site);
    if (sequence) out.sequenceKeysPerSite = Math.max(out.sequenceKeysPerSite, keys);
    if (firstStep) out.firstStepKeys = Math.max(out.firstStepKeys, keys);
  }
  for (const [site, keys] of schemaKeysBySite) {
    if ((JSON.parse(site) as unknown[])[0] === "Telo.Application") out.applicationSchemaKeys = Math.max(out.applicationSchemaKeys, keys);
  }
  return out;
}

function row(label: string, c: Counted): string {
  return (
    `${label}: setups=${c.setups} doors(keys)=${c.doors} own(keys)=${c.owns} scopeFor=${c.scopes} typedEnvironments=${c.environments} ` +
    `normalizations=${c.normalizations} invariant=${c.invariant} (distinct pairs ${c.invariantPairs}) ` +
    `relation(keys)=${c.relationKeys} over ${c.relationSites} sites (≤${c.keysPerSite} per site; ≤${c.nodesPerKey} nodes per key, ` +
    `${c.relationNodes} in all; regions normalized ${c.regionNodes} nodes) other own(keys)=${c.owns - c.relationKeys} ` +
    `door=${c.doorMs.toFixed(0)}ms (${(c.doorMs / Math.max(c.doors, 1)).toFixed(3)} ms/key) ` +
    `schema(keys)=${c.schemaKeys} over ${c.schemaSites} sites (≤${c.schemaKeysPerSite} per site; Application site ${c.applicationSchemaKeys}) ` +
    `nodes per key: cel ≤${c.celNodesPerKey}, schema ≤${c.schemaNodesPerKey} ` +
    `(at sites of 'sequence': cel ≤${c.sequenceCelNodesPerKey}, schema ≤${c.sequenceSchemaNodesPerKey}; ` +
    `in all: cel ${c.celNodes}, schema ${c.schemaNodes}) ` +
    `schema own extent: ≤${c.schemaExtentPerKey} per key, ${c.schemaExtents} in all (at sites of 'sequence' ≤${c.sequenceSchemaExtentPerKey}; ` +
    `Application site nodes ≤${c.applicationSchemaNodes}, extent ≤${c.applicationSchemaExtent}); ` +
    `${c.schemaKeysOverExtent} keys whose nodes differ from it (nodes − extent ≤${c.schemaOverExtent}; at 'sequence' ≤${c.sequenceSchemaOverExtent}) ` +
    `cel own extent: ≤${c.celExtentPerKey} per key, ${c.celExtents} in all (at sites of 'sequence' ≤${c.sequenceCelExtentPerKey}); ` +
    `${c.celKeysOverExtent} keys whose nodes differ from it (nodes − extent ≤${c.celOverExtent}; at 'sequence' ≤${c.sequenceCelOverExtent}; ` +
    `${c.celKeysWithoutExtent} keys with none) ` +
    `sequence relation sites: ≤${c.sequenceKeysPerSite} keys, ≤${c.sequenceNodesPerKey} nodes per key; ` +
    `at steps[0]: ${c.firstStepKeys} keys, ≤${c.firstStepNodes} nodes per key ` +
    `reads into another site's region: ${c.carveReads} ` +
    `door nodes per key (${FAMILIES.join("/")}): ${FAMILIES.map((f) => `≤${c.door[f].perKey}`).join("/")}, ` +
    `in all ${FAMILIES.map((f) => c.door[f].total).join("/")}, of declarations reached by name ` +
    `${FAMILIES.map((f) => c.door[f].byName).join("/")} (${FAMILIES.map((f) => c.door[f].byNameOff).join("/")} keys off their read extent) ` +
    `whole by name ${FAMILIES.map((f) => `${c.door[f].whole}${c.door[f].wholeReads.size > 0 ? ` [${[...c.door[f].wholeReads].sort().join(",")}]` : ""}`).join("/")} ` +
    `analyze=${c.totalMs.toFixed(0)}ms post-loop=${(c.totalMs - c.loopMs).toFixed(0)}ms`
  );
}

const padding = await Promise.all(
  [0, 100, 1000].map(async (p) => [p, await loadGenerated(`door-cost-padding-${p}.yaml`, flagSequence(2, p))] as const),
);
describe("padding", () => {
  for (const [p, { manifests, moduleDocuments }] of padding) {
    let printed = false;
    bench(
      `V N=2 P=${p}`,
      () => {
        const c = counted(() => new StaticAnalyzer().analyze(manifests, { moduleDocuments }));
        if (!printed) console.log(row(`V N=2 P=${p}`, c));
        printed = true;
      },
      { iterations: 3, warmupIterations: 1 },
    );
  }
});

const unread = await Promise.all(
  [0, 100, 1000].map(async (p) => [p, await loadGenerated(`door-cost-unread-${p}.yaml`, flagSequence(2, 0, p))] as const),
);
describe("unread", () => {
  for (const [p, { manifests, moduleDocuments }] of unread) {
    let printed = false;
    bench(
      `V N=2 unread P=${p}`,
      () => {
        const c = counted(() => new StaticAnalyzer().analyze(manifests, { moduleDocuments }));
        if (!printed) console.log(row(`V N=2 unread P=${p}`, c));
        printed = true;
      },
      { iterations: 3, warmupIterations: 1 },
    );
  }
});

const sequences = await Promise.all(
  V.map(async (n) => [n, await loadGenerated(`door-cost-V-${n}.yaml`, flagSequence(n))] as const),
);
const tried = await Promise.all(
  V.map(async (n) => [n, await loadGenerated(`door-cost-W-${n}.yaml`, flagSequenceInTry(n))] as const),
);
const targets = await Promise.all(
  V.map(async (n) => [n, await loadGenerated(`door-cost-S-${n}.yaml`, flagTargets(n))] as const),
);
const forwarded = await Promise.all(
  V.map(async (n) => [n, await loadGenerated(`door-cost-T-${n}.yaml`, forwardedSequence(n))] as const),
);
const forwardedNested = (form: "inline" | "with") =>
  Promise.all(
    V.map(async (n) => [n, await loadGenerated(`door-cost-Tn-${form}-${n}.yaml`, forwardedSequenceNested(n, form))] as const),
  );
const forwardedInline = await forwardedNested("inline");
const forwardedWith = await forwardedNested("with");
const inlineSequences = (chosen: boolean) =>
  Promise.all(
    V.map(async (n) => [n, await loadGenerated(`door-cost-Ti${chosen ? "-choice" : ""}-${n}.yaml`, inlineSequence(n, chosen))] as const),
  );
const inline = await inlineSequences(false);
const inlineChosen = await inlineSequences(true);
const costSets = (shape: "isolated" | "reached") =>
  Promise.all(
    ([0, 1, 2, 4] as const).map(
      async (n) => [n, await loadGenerated(`door-cost-${shape}-${n}.yaml`, costApplication(shape, n))] as const,
    ),
  );
const isolated = await costSets("isolated");
const reached = await costSets("reached");
describe("counters", () => {
  for (const [label, sets] of [
    ["V", sequences],
    ["W", tried],
    ["S", targets],
    ["T", forwarded],
    ["Tn-inline", forwardedInline],
    ["Tn-with", forwardedWith],
    ["Ti", inline],
    ["Ti-choice", inlineChosen],
    ["isolated", isolated],
    ["reached", reached],
  ] as const) {
    for (const [n, { manifests, moduleDocuments }] of sets) {
      let printed = false;
      bench(
        `${label} N=${n}`,
        () => {
          // T's sequence is the view of what `wrapped` forwards: its sites are
          // written in `wrapped` — Tn's in `holder`, which declares its
          // consumer.
          const written = label === "T" ? "wrapped" : label.startsWith("Tn") || label.startsWith("Ti") ? "holder" : "sequence";
          const c = counted(() => new StaticAnalyzer().analyze(manifests, { moduleDocuments }), written);
          if (!printed) console.log(row(`${label} N=${n}`, c));
          printed = true;
        },
        { iterations: 1, warmupIterations: 0 },
      );
    }
  }
});

const inlineDeclared = await Promise.all(
  [1, 4, 16].map(async (k) => [k, await loadGenerated(`door-cost-K-${k}.yaml`, inlineDeclarations(k))] as const),
);
describe("inline declarations", () => {
  for (const [k, { manifests, moduleDocuments }] of inlineDeclared) {
    // One configuration kept: the cut is decided over the union whatever
    // `within` keeps, while 2^16 configuration runs are not.
    const within = Object.fromEntries(Array.from({ length: k }, (_, i) => [`variables.flag${i + 1}`, false]));
    let printed = false;
    bench(
      `K k=${k}`,
      () => {
        let enumerations = 0;
        let settling = 0;
        let cutting = 0;
        const stop = observeKeyCosts((cost) => {
          if (cost.kind === "nested-places") {
            enumerations += cost.enumerations;
            settling += cost.milliseconds;
          } else if (cost.kind === "own-cut") cutting += cost.milliseconds;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments, within });
        } finally {
          stop();
        }
        if (!printed) {
          console.log(
            `K k=${k}: enumerations=${enumerations} settling=${settling.toFixed(2)}ms cutting=${cutting.toFixed(2)}ms`,
          );
        }
        printed = true;
      },
      { iterations: 3, warmupIterations: 1 },
    );
  }
});

const chains = await Promise.all(
  [8, 16, 32].map(async (k) => [k, await loadGenerated(`door-cost-F-${k}.yaml`, forwardChain(k))] as const),
);
describe("forward chain", () => {
  for (const [k, { manifests, moduleDocuments }] of chains) {
    let printed = false;
    bench(
      `F k=${k}`,
      () => {
        const c = counted(() => new StaticAnalyzer().analyze(manifests, { moduleDocuments }));
        if (!printed) console.log(row(`F k=${k}`, c));
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const crossedPadding = await Promise.all(
  [0, 100, 1000].map(async (p) => [p, await loadGenerated(`door-cost-crossed-padding-${p}.yaml`, crossedReferentPadding(p))] as const),
);
describe("crossed padding", () => {
  for (const [p, { manifests, moduleDocuments }] of crossedPadding) {
    let printed = false;
    bench(
      `crossed padding P=${p}`,
      () => {
        const door = Object.fromEntries(
          FAMILIES.map((f) => [f, { keys: 0, perKey: 0, byName: 0, off: 0, ms: 0 }]),
        ) as Record<Family, { keys: number; perKey: number; byName: number; off: number; ms: number }>;
        const stop = observeKeyCosts((cost) => {
          if ((cost.kind !== "door-nodes" && cost.kind !== "door") || !ofDeclaration(cost.site, "viaRef")) return;
          const row = door[cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.keys++;
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.byName = Math.max(row.byName, cost.byNameNodes);
          if (cost.byNameNodes !== cost.byNameExtent) row.off++;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          console.log(
            `crossed padding P=${p}: keys of 'viaRef' and its views, per family — ` +
              FAMILIES.map(
                (f) =>
                  `${f}: ${door[f].keys} keys, ≤${door[f].perKey} door nodes per key (≤${door[f].byName} by name, ` +
                  `${door[f].off} keys off their read extent), ${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
              ).join("; "),
          );
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const nameReads = await Promise.all(
  [0, 100, 1000].map(async (p) => [p, await loadGenerated(`door-cost-name-padding-${p}.yaml`, nameReadPadding(p))] as const),
);
describe("name-read padding", () => {
  for (const [p, { manifests, moduleDocuments }] of nameReads) {
    let printed = false;
    bench(
      `name-read padding P=${p}`,
      () => {
        const door = Object.fromEntries(
          FAMILIES.map((f) => [f, { keys: 0, perKey: 0, byName: 0, whole: 0, ms: 0 }]),
        ) as Record<Family, { keys: number; perKey: number; byName: number; whole: number; ms: number }>;
        const stop = observeKeyCosts((cost) => {
          if ((cost.kind !== "door-nodes" && cost.kind !== "door") || !ofDeclaration(cost.site, "reader")) return;
          const row = door[cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.keys++;
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.byName = Math.max(row.byName, cost.byNameNodes);
          row.whole += cost.wholeByName;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          console.log(
            `name-read padding P=${p}: keys of 'reader', per family — ` +
              FAMILIES.map(
                (f) =>
                  `${f}: ${door[f].keys} keys, ≤${door[f].perKey} door nodes per key (≤${door[f].byName} by name, ` +
                  `${door[f].whole} whole by name), ${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
              ).join("; "),
          );
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const referenceReads = await Promise.all(
  (
    [
      ["rule", "form", rulePadding],
      ["catalog set", "set", catalogSetPadding],
      ["zone", "work", zonePadding],
    ] as const
  ).flatMap(([label, reader, fixture]) =>
    [0, 100, 1000].map(
      async (p) =>
        [label, reader, p, await loadGenerated(`door-cost-reference-${reader}-${p}.yaml`, fixture(p))] as const,
    ),
  ),
);
describe("reference-read padding", () => {
  for (const [label, reader, p, { manifests, moduleDocuments }] of referenceReads) {
    let printed = false;
    bench(
      `reference-read padding ${label} P=${p}`,
      () => {
        const door = Object.fromEntries(
          FAMILIES.map((f) => [f, { keys: 0, perKey: 0, byName: 0, whole: 0, ms: 0 }]),
        ) as Record<Family, { keys: number; perKey: number; byName: number; whole: number; ms: number }>;
        const stop = observeKeyCosts((cost) => {
          if ((cost.kind !== "door-nodes" && cost.kind !== "door") || !ofDeclaration(cost.site, reader)) return;
          const row = door[cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.keys++;
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.byName = Math.max(row.byName, cost.byNameNodes);
          row.whole += cost.wholeByName;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          console.log(
            `reference-read padding ${label} P=${p}: keys of '${reader}', per family — ` +
              FAMILIES.map(
                (f) =>
                  `${f}: ${door[f].keys} keys, ≤${door[f].perKey} door nodes per key (≤${door[f].byName} by name, ` +
                  `${door[f].whole} whole by name), ${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
              ).join("; "),
          );
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const varyingReferent = await Promise.all(
  [0, 100, 1000].map(
    async (p) => [p, await loadGenerated(`door-cost-varying-referent-${p}.yaml`, referentPadding(p))] as const,
  ),
);
const VARYING_REFERENT_READERS = [
  ["x-telo-ref", "ReferentPadding"],
  ["context-ref-from", "caller"],
  ["schema-from", "shaped"],
  ["scope", "scoped"],
  ["returns-from", "measure"],
  ["context-from-referrer", "field"],
] as const;
describe("varying-referent padding", () => {
  for (const [p, { manifests, moduleDocuments }] of varyingReferent) {
    let printed = false;
    bench(
      `varying-referent padding P=${p}`,
      () => {
        const rows = new Map(
          VARYING_REFERENT_READERS.map(([, reader]) => [
            reader,
            Object.fromEntries(FAMILIES.map((f) => [f, { keys: 0, perKey: 0, byName: 0, whole: 0, ms: 0 }])) as Record<
              Family,
              { keys: number; perKey: number; byName: number; whole: number; ms: number }
            >,
          ]),
        );
        const stop = observeKeyCosts((cost) => {
          if (cost.kind !== "door-nodes" && cost.kind !== "door") return;
          const reader = VARYING_REFERENT_READERS.find(([, name]) => ofDeclaration(cost.site, name))?.[1];
          if (!reader) return;
          const row = rows.get(reader)![cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.keys++;
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.byName = Math.max(row.byName, cost.byNameNodes);
          row.whole += cost.wholeByName;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          for (const [label, reader] of VARYING_REFERENT_READERS) {
            const door = rows.get(reader)!;
            console.log(
              `varying-referent padding ${label} P=${p}: keys of '${reader}', per family — ` +
                FAMILIES.map(
                  (f) =>
                    `${f}: ${door[f].keys} keys, ≤${door[f].perKey} door nodes per key (≤${door[f].byName} by name, ` +
                    `${door[f].whole} whole by name), ${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
                ).join("; "),
            );
          }
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const relationReads = await Promise.all(
  [0, 100, 1000].map(
    async (p) => [p, await loadGenerated(`door-cost-relation-padding-${p}.yaml`, relationPadding(p))] as const,
  ),
);
const RELATION_READERS = [
  ["nested", "nesting"],
  ["contracts", "projected"],
  ["templateTargets", "Wrapper"],
  ["slot fit", "fitted"],
  ["stepInputs", "stepping"],
  ["slotInputs", "slotting"],
] as const;
describe("relation-read padding", () => {
  for (const [p, { manifests, moduleDocuments }] of relationReads) {
    let printed = false;
    bench(
      `relation-read padding P=${p}`,
      () => {
        const rows = new Map(
          RELATION_READERS.map(([, reader]) => [
            reader,
            Object.fromEntries(FAMILIES.map((f) => [f, { keys: 0, perKey: 0, byName: 0, whole: 0, ms: 0 }])) as Record<
              Family,
              { keys: number; perKey: number; byName: number; whole: number; ms: number }
            >,
          ]),
        );
        const stop = observeKeyCosts((cost) => {
          if (cost.kind !== "door-nodes" && cost.kind !== "door") return;
          const reader = RELATION_READERS.find(([, name]) => ofDeclaration(cost.site, name))?.[1];
          if (!reader) return;
          const row = rows.get(reader)![cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.keys++;
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.byName = Math.max(row.byName, cost.byNameNodes);
          row.whole += cost.wholeByName;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          for (const [label, reader] of RELATION_READERS) {
            const door = rows.get(reader)!;
            console.log(
              `relation-read padding ${label} P=${p}: keys of '${reader}', per family — ` +
                FAMILIES.map(
                  (f) =>
                    `${f}: ${door[f].keys} keys, ≤${door[f].perKey} door nodes per key (≤${door[f].byName} by name, ` +
                    `${door[f].whole} whole by name), ${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
                ).join("; "),
            );
          }
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const scopeReads = await Promise.all(
  [0, 4, 8].map(async (p) => [p, await loadGenerated(`door-cost-scope-padding-${p}.yaml`, scopePadding(p))] as const),
);
describe("scope padding", () => {
  for (const [p, { manifests, moduleDocuments }] of scopeReads) {
    let printed = false;
    bench(
      `scope padding P=${p}`,
      () => {
        const door = Object.fromEntries(
          FAMILIES.map((f) => [f, { sites: new Set<string>(), keys: 0, perKey: 0, total: 0, whole: 0, ms: 0 }]),
        ) as Record<Family, { sites: Set<string>; keys: number; perKey: number; total: number; whole: number; ms: number }>;
        // A site of `holder` a region of `padded` does not hold: neither in it
        // nor its declaration's root.
        const outside = (site: string): boolean => {
          const id = JSON.parse(site) as unknown[];
          const [name, path] = id[0] === "relation" ? [id[3], id[5]] : [id[1], id[3]];
          const text = Array.isArray(path) ? path.join(".") : String(path);
          return name === "holder" && text !== "" && !text.startsWith("with[1]") && !text.startsWith("with.1");
        };
        const keysOf = new Map<string, number>();
        const stop = observeKeyCosts((cost) => {
          if ((cost.kind !== "door-nodes" && cost.kind !== "door") || !outside(cost.site)) return;
          const row = door[cost.family];
          if (cost.kind === "door") {
            row.ms += cost.milliseconds;
            return;
          }
          row.sites.add(cost.site);
          row.keys++;
          keysOf.set(cost.site, (keysOf.get(cost.site) ?? 0) + 1);
          row.perKey = Math.max(row.perKey, cost.nodes);
          row.total += cost.nodes;
          row.whole += cost.wholeByName;
        });
        try {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        } finally {
          stop();
        }
        if (!printed) {
          console.log(
            `scope padding P=${p}: sites of 'holder' outside 'padded', per family — ` +
              FAMILIES.map(
                (f) =>
                  `${f}: ${door[f].keys} keys over ${door[f].sites.size} sites ` +
                  `(≤${Math.max(0, ...[...door[f].sites].map((site) => keysOf.get(site) ?? 0))} per site), ` +
                  `≤${door[f].perKey} door nodes per key, ${door[f].total} in all, ${door[f].whole} whole by name, ` +
                  `${(door[f].ms / Math.max(door[f].keys, 1)).toFixed(3)} ms/key`,
              ).join("; "),
          );
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

const narrowed = await Promise.all(
  ([["V", flagSequence], ["S", flagTargets]] as const).flatMap(([label, fixture]) =>
    [4, 8].map(async (n) => [`${label} N=${n}`, await loadGenerated(`door-cost-within-${label}-${n}.yaml`, fixture(n))] as const),
  ),
);
describe("within", () => {
  for (const [label, { manifests, moduleDocuments }] of narrowed) {
    let printed = false;
    bench(
      `${label} within each configuration`,
      () => {
        const options = { moduleDocuments };
        const { configurations } = new StaticAnalyzer().configurationsOf(manifests, options);
        let keysPerSite = 0;
        let held = 0;
        let varying = 0;
        let firstMs = 0;
        let mostMs = 0;
        let mostAt = "";
        for (const [i, within] of configurations.entries()) {
          const keys = new Map<string, number>();
          const ids = new Map<object, number>();
          const stop = observeKeyCosts((cost) => {
            if (cost.kind === "key-presence" && cost.role === "live") {
              if (!ids.has(cost.declaration)) ids.set(cost.declaration, ids.size);
              const at = JSON.stringify([cost.family, cost.site, ids.get(cost.declaration), cost.unionKeys ?? null, cost.variant]);
              keys.set(at, (keys.get(at) ?? 0) + 1);
            } else if (cost.kind === "varying" && cost.live) held += cost.declarations;
            else if (cost.kind === "normalization" && cost.live && !cost.invariant) varying++;
          });
          const started = performance.now();
          try {
            new StaticAnalyzer().analyze(manifests, { ...options, within });
          } finally {
            stop();
          }
          const ms = performance.now() - started;
          if (i === 0) firstMs = ms;
          if (ms > mostMs) [mostMs, mostAt] = [ms, assignmentKey(within)];
          keysPerSite = Math.max(keysPerSite, ...keys.values());
        }
        if (!printed) {
          console.log(
            `${label} within each of ${configurations.length} configurations: ≤${keysPerSite} keys per site, ` +
              `${held} varying declarations held, ${varying} normalized, first ${firstMs.toFixed(0)}ms, most ${mostMs.toFixed(0)}ms (${mostAt})`,
          );
        }
        printed = true;
      },
      { iterations: 1, warmupIterations: 0 },
    );
  }
});

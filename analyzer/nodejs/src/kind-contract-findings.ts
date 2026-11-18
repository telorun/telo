/**
 * What a kind document's contract and signature refuse of the kinds it
 * extends, over every configuration at once: a throw code outside the nearest
 * ceiling, an own `inputType` / `outputType` with no mapping bridging it to the
 * inherited controller, and a contract or signature that cannot stand in for
 * an abstract ancestor's. A kind document never varies; the named shapes its
 * contracts compare through may.
 *
 * The comparison is `schema-compat.ts`'s, read through a lookup that never
 * reads a named shape: a reference to one, on either side, defers the pair
 * (`DeferredPair`). Each pair is judged once per class pair of the two
 * positions it compares — a node of a shape class, or of a kind document's
 * contract — memoised by the named-shape reader, and the judgements are joined
 * in three ordered stages over the graph they make:
 *
 *  1. compatibility, a greatest fixpoint: every node compatible until its own
 *     conflicts, a deferred pair it needs, or a union it needs says otherwise,
 *     so a recursive shape compared with itself is compatible;
 *  2. each union's verdict from it: it fails where every alternative does;
 *  3. reach, a least fixpoint from each kind's own comparison: a pair is
 *     reached where its class pair holds and, when it is compared as an
 *     alternative of a union, where that union fails.
 *
 * A pair failing on its own content is one finding at the kind's path, held
 * where it is reached; a union failing only where its deferred alternatives do
 * is a second finding of the pair that holds it, held where it fails. No
 * fixpoint iteration reads a shape.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { claimsDeterministic, isCallableKind, signatureDeclarer } from "./callable-signature.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isEntryOwned } from "./entry-ownership.js";
import {
  ancestorChain,
  type ContractDirection,
  type DefResolver,
  hasOwnControllerOrTemplate,
  mappingFieldFor,
  needsContractMapping,
  resolveParent,
} from "./extends-resolution.js";
import { isHoistedFragmentDefKey } from "./manifest-schemas.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { nodeAtPointer, type NamedShapeReader } from "./named-shape-reader.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { registeredDefinitionCopy } from "./resolve-schema-type-refs.js";
import {
  judgeSchemaCompatibility,
  type CompatDocument,
  type CompatJudgement,
  type CompatLookup,
  type CompatSide,
  type DeferredPair,
  type PairSide,
  type UnionAlternative,
  type UnionTerm,
} from "./schema-compat.js";
import { schemaReferenceParts } from "./schema-reference.js";
import { isSignatureComparison, signatureComparisons } from "./signature-substitution.js";
import { codesOutsideCeiling, throwsNotSubstitutableMessage } from "./throws-ceiling.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import type { ReadFinding } from "./union-passes.js";
import { describeSignatureMismatch } from "./validate-invocation-contract.js";

const SOURCE = "telo-analyzer";

type Schema = Record<string, any>;

export interface KindContractScope {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The named shapes, as the analysis reads them. */
  readonly shapes: NamedShapeReader;
}

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** A stable number per object, for a memo keyed on the nodes a pair compares. */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) objectIds.set(value, (id = nextObjectId++));
  return id;
}

/** One comparison of the graph: a node of each side, in one class each. */
interface PairNode {
  readonly key: string;
  readonly source: CompatSide;
  readonly target: CompatSide;
  readonly judgement: CompatJudgement;
  /** Each deferred pair's comparisons, one per class pair, with where the pair holds. */
  readonly expansions: Map<DeferredPair, { readonly node: PairNode; readonly condition: Condition }[]>;
  ok: Condition;
}

/** What one comparison finds, at the kind: the issue text, and where it holds. */
export interface ComparisonFinding {
  readonly text: string;
  readonly held: Condition;
}

/**
 * The pair graph of one analysis: every comparison the kinds' contracts and
 * signatures make, each judged once, with compatibility and union verdicts
 * settled over all of them.
 */
class ContractPairGraph {
  private readonly nodes = new Map<string, PairNode>();
  private readonly pending: PairNode[] = [];
  private readonly shapeDocs = new Map<string, CompatDocument & { written?: unknown }>();
  private readonly unionFails = new Map<UnionTerm, Condition>();
  private settled = false;
  private readonly lookup: CompatLookup;

  constructor(
    private readonly shapes: NamedShapeReader,
    defs: DefinitionRegistry,
    /** A named shape's schema as written, where the documents judged hold it. */
    private readonly writtenShape: (id: string) => unknown,
  ) {
    const lookupDefs = defs;
    this.lookup = {
      defers: (node) => {
        if (typeof node.$ref !== "string") return undefined;
        const { shape, pointer } = schemaReferenceParts(node.$ref);
        return shape !== undefined && shapes.isShapeId(shape) ? { target: shape, pointer } : undefined;
      },
      follow: (side, other) => {
        const ref = side.node.$ref;
        if (typeof ref !== "string") return side;
        if (ref.startsWith("#")) {
          // A document-local pointer is read in place, in the document it is written in.
          const node = nodeAtPointer(side.root, ref);
          if (isObject(node)) return { ...side, node, at: ref };
          // A hoisted fragment of a signature slot may sit in the other slot.
          const key = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
          const hoisted = key !== undefined && isHoistedFragmentDefKey(key) ? other.root.$defs?.[key] : undefined;
          return isObject(hoisted) ? { node: hoisted, root: other.root, at: ref, doc: other.doc } : side;
        }
        // A kind's schema or a shared fragment: never a choice.
        const schema = lookupDefs.schemaForId(ref);
        return schema ? { node: schema, root: schema, at: "#", doc: { label: ref } } : side;
      },
      guardKey: (source, target) =>
        `${objectId(source.root)}${source.node.$ref}|${objectId(target.root)}${target.node.$ref}`,
    };
  }

  /** The comparison of `source` standing in for `target`, from a kind's own contract. */
  root(source: CompatSide, target: CompatSide): PairNode {
    if (this.settled) throw new Error("internal: a contract comparison was added after the pair graph settled.");
    return this.node(source, target, false, false);
  }

  private node(source: CompatSide, target: CompatSide, beneathTypeArgument: boolean, fillsDefaults: boolean): PairNode {
    const key = [
      objectId(source.node),
      objectId(source.root),
      objectId(target.node),
      objectId(target.root),
      beneathTypeArgument ? 1 : 0,
      fillsDefaults ? 1 : 0,
    ].join(".");
    const known = this.nodes.get(key);
    if (known) return known;
    const judgement = this.shapes.pairVerdict("contractCompat", key, () =>
      judgeSchemaCompatibility(source, target, this.lookup, undefined, {
        targetFillsDefaults: fillsDefaults,
        beneathTypeArgument,
      }),
    );
    const node: PairNode = { key, source, target, judgement, expansions: new Map(), ok: TRUE };
    this.nodes.set(key, node);
    this.pending.push(node);
    return node;
  }

  /** Each class of a deferred pair's side, as the side compared there. */
  private classSides(side: PairSide): { condition: Condition; side: CompatSide }[] {
    if (!side.named) return [{ condition: TRUE, side: side.side }];
    const out: { condition: Condition; side: CompatSide }[] = [];
    // A shape nothing declares is compatible; its reference is reported elsewhere.
    for (const each of this.shapes.classes(side.target)) {
      const node = nodeAtPointer(each.schema, side.pointer);
      if (!isObject(node)) continue;
      out.push({ condition: each.condition, side: { node, root: each.schema, at: side.pointer, doc: this.shapeDoc(side.target) } });
    }
    return out;
  }

  /** How a named shape's own nodes are named, and its written content. */
  shapeDoc(id: string): CompatDocument & { written?: unknown } {
    let doc = this.shapeDocs.get(id);
    if (!doc) {
      const declarations = this.shapes.declarationsOf(id);
      const written =
        this.writtenShape(id) ?? (declarations.length === 1 ? (declarations[0]!.manifest as Schema).schema : undefined);
      doc = { label: parseCanonicalTypeSchemaId(id)?.typeName ?? id, ...(written !== undefined ? { written } : {}) };
      this.shapeDocs.set(id, doc);
    }
    return doc;
  }

  /** Builds the graph every root reaches and settles compatibility and each
   *  union's verdict. Reads every judgement it needs here, once. */
  solve(): void {
    if (this.settled) return;
    this.settled = true;
    const { space } = this.shapes;
    while (this.pending.length > 0) {
      const node = this.pending.pop()!;
      for (const pair of node.judgement.deferred) {
        const list: { node: PairNode; condition: Condition }[] = [];
        for (const left of this.classSides(pair.source)) {
          for (const right of this.classSides(pair.target)) {
            const condition = space.and(left.condition, right.condition);
            if (condition === FALSE) continue;
            list.push({ node: this.node(left.side, right.side, pair.beneathTypeArgument, pair.fillsDefaults), condition });
          }
        }
        node.expansions.set(pair, list);
      }
    }
    // 1. Compatibility: the greatest fixpoint, every node compatible until its
    //    own content or what it needs says otherwise.
    const dependents = new Map<PairNode, Set<PairNode>>();
    for (const node of this.nodes.values()) {
      for (const list of node.expansions.values()) {
        for (const { node: child } of list) {
          let set = dependents.get(child);
          if (!set) dependents.set(child, (set = new Set()));
          set.add(node);
        }
      }
    }
    const work = [...this.nodes.values()];
    const queued = new Set(work);
    while (work.length > 0) {
      const node = work.pop()!;
      queued.delete(node);
      const ok = this.compatibility(node);
      if (ok === node.ok) continue;
      node.ok = ok;
      for (const parent of dependents.get(node) ?? []) {
        if (queued.has(parent)) continue;
        queued.add(parent);
        work.push(parent);
      }
    }
    // 2. Each union's verdict, from the compatibility settled.
    for (const node of this.nodes.values()) this.unionVerdicts(node, node.judgement.unions);
  }

  private pairHolds(node: PairNode, pair: DeferredPair): Condition {
    const { space } = this.shapes;
    let fails: Condition = FALSE;
    for (const { node: child, condition } of node.expansions.get(pair) ?? []) {
      fails = space.or(fails, space.and(condition, space.not(child.ok)));
    }
    return space.not(fails);
  }

  private needs(node: PairNode, pairs: readonly DeferredPair[], unions: readonly UnionTerm[]): Condition {
    const { space } = this.shapes;
    let held: Condition = TRUE;
    for (const pair of pairs) held = space.and(held, this.pairHolds(node, pair));
    for (const union of unions) held = space.and(held, this.unionHolds(node, union));
    return held;
  }

  private unionHolds(node: PairNode, union: UnionTerm): Condition {
    const { space } = this.shapes;
    let held: Condition = FALSE;
    for (const alternative of union.alternatives) {
      if (alternative.fails) continue;
      held = space.or(held, this.needs(node, alternative.pairs, alternative.unions));
    }
    return held;
  }

  private compatibility(node: PairNode): Condition {
    if (node.judgement.conflicts.length > 0) return FALSE;
    return this.needs(node, node.judgement.pairs, node.judgement.unions);
  }

  private unionVerdicts(node: PairNode, unions: readonly UnionTerm[]): void {
    for (const union of unions) {
      this.unionFails.set(union, this.shapes.space.not(this.unionHolds(node, union)));
      for (const alternative of union.alternatives) if (!alternative.fails) this.unionVerdicts(node, alternative.unions);
    }
  }

  /**
   * 3. What `root` finds: a least fixpoint of where each node is reached from
   * it, within `at`, then each failing node's finding there — the root's in
   * its own words, a nested pair's naming the two sides it compares.
   */
  findings(root: PairNode, at: Condition): ComparisonFinding[] {
    if (!this.settled) throw new Error("internal: a contract comparison was read before the pair graph settled.");
    const { space } = this.shapes;
    const label = (pair: DeferredPair): Condition => {
      let held: Condition = TRUE;
      for (const union of pair.under) held = space.and(held, this.unionFails.get(union) ?? FALSE);
      return held;
    };
    const reach = new Map<PairNode, Condition>();
    for (const { node, condition } of this.shapes
      .reachOver(
        [{ node: root, condition: at }],
        (node) =>
          [...node.expansions].flatMap(([pair, list]) => {
            const through = label(pair);
            return list.map(({ node: child, condition }) => ({ node: child, condition: space.and(through, condition) }));
          }),
        (node) => node.key,
      )
      .values()) {
      reach.set(node, condition);
    }
    const out = new Map<string, Condition>();
    const add = (text: string, held: Condition) => {
      if (held === FALSE) return;
      out.set(text, space.or(out.get(text) ?? FALSE, held));
    };
    // The root's own: its conflicts, then each union failing through deferred pairs.
    const own = (node: PairNode, held: Condition, framed: (text: string) => string) => {
      if (node.judgement.conflicts.length > 0) add(framed(node.judgement.conflicts.map((c) => c.message).join("; ")), held);
      for (const union of node.judgement.unions) add(framed(this.unionText(union)), space.and(held, this.unionFails.get(union) ?? FALSE));
    };
    // A contract that IS a reference — to a shape, or a shape that is one —
    // compares the shape it names as the root pair, in the root's words.
    const rootLevel = new Set<PairNode>([root]);
    const asRoot = (from: PairNode, pair: DeferredPair) => rootLevel.has(from) && pair.path === "" && pair.under.length === 0;
    for (const node of rootLevel) {
      for (const [pair, list] of node.expansions) if (asRoot(node, pair)) for (const { node: child } of list) rootLevel.add(child);
    }
    own(root, at, (text) => text);
    for (const [node, held] of reach) {
      for (const [pair, list] of node.expansions) {
        const through = space.and(held, label(pair));
        if (through === FALSE) continue;
        const named = `comparing '${this.sideLabel(pair.source)}' with '${this.sideLabel(pair.target)}'`;
        const as = pair.under.length > 0 ? `, compared as an alternative at '${pair.under[pair.under.length - 1]!.path}'` : "";
        const framed = asRoot(node, pair) ? (text: string) => text : (text: string) => `${named}${as}: ${text}`;
        for (const { node: child, condition } of list) own(child, space.and(through, condition), framed);
      }
    }
    return [...out].map(([text, held]) => ({ text, held }));
  }

  /** A union failing where its deferred alternatives do, in today's words:
   *  an alternative failing on its own gives its own reason, one depending on
   *  deferred pairs names them. */
  private unionText(union: UnionTerm): string {
    const reasons: string[] = [];
    for (const alternative of union.alternatives) {
      if (alternative.fails) reasons.push(...alternative.reasons);
      else reasons.push(this.alternativeText(alternative));
    }
    return `${union.path}: no alternative matches — ${[...new Set(reasons)].join("; ")}`;
  }

  private alternativeText(alternative: Extract<UnionAlternative, { fails: false }>): string {
    const pairs: DeferredPair[] = [];
    const gather = (each: Extract<UnionAlternative, { fails: false }>) => {
      pairs.push(...each.pairs);
      for (const union of each.unions) for (const inner of union.alternatives) if (!inner.fails) gather(inner);
    };
    gather(alternative);
    const named = (pair: DeferredPair) => `'${this.sideLabel(pair.source)}'/'${this.sideLabel(pair.target)}'`;
    if (pairs.length === 1 && alternative.unions.length === 0) {
      return `the alternative comparing '${this.sideLabel(pairs[0]!.source)}' with '${this.sideLabel(pairs[0]!.target)}' does not stand in`;
    }
    return `the alternative fails in at least one of ${[...new Set(pairs.map(named))].join(", ")}`;
  }

  /** A side as written: a named shape by the reference naming it, a node by
   *  its document and pointer. */
  sideLabel(side: PairSide): string {
    if (!side.named) return side.side.at === "#" ? side.side.doc.label : `${side.side.doc.label}${side.side.at}`;
    const holder = side.holder;
    const written = (holder.doc as { written?: unknown }).written;
    const text = writtenReference(written === undefined ? undefined : nodeAtPointer(written, holder.at));
    if (text !== undefined) return text;
    const id = parseCanonicalTypeSchemaId(side.target);
    return `${id?.typeName ?? side.target}${side.pointer === "#" ? "" : side.pointer}`;
  }
}

/** A reference's text as an author wrote it, or undefined. */
function writtenReference(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (isRefSentinel(node)) return refSentinelTarget(node)?.source ?? node.source;
  if (isResolvedReference(node)) return node.alias !== undefined ? `${node.alias}.${node.name}` : node.name;
  if (isObject(node) && typeof node.$ref === "string") return node.$ref;
  return undefined;
}

/** A definition's canonical `<module>.<Kind>` label. */
function kindLabel(def: { metadata?: unknown }): string {
  const metadata = def.metadata as { module?: string; name?: string } | undefined;
  return `${metadata?.module ?? ""}.${metadata?.name ?? "?"}`.replace(/^\./, "");
}

/** The registry key of a kind document. */
function registryKey(m: { metadata?: unknown }): string | undefined {
  const metadata = m.metadata as { module?: unknown; name?: unknown } | undefined;
  if (typeof metadata?.name !== "string") return undefined;
  return typeof metadata.module === "string" && metadata.module ? `${metadata.module}.${metadata.name}` : metadata.name;
}

/** A contract field's root node and the document it lives in, from the
 *  canonical copy, with the written field it mirrors: a reference by name made
 *  the id of the shape it names, an inline type resource its `schema`. Raw
 *  JSON Schema counts when it says a `type` or `properties`. */
export function contractRoot(
  value: unknown,
  written: unknown,
  module: string | undefined,
  scope: AliasResolver,
  shapes: NamedShapeReader,
): { node: Schema; written: unknown } | undefined {
  const named = (name: string, alias?: string): Schema | undefined => {
    if (alias !== undefined && alias !== "Self") {
      const owner = scope.moduleForAlias(alias);
      return owner ? { $ref: canonicalTypeSchemaId(owner, name) } : undefined;
    }
    // By name, as the scoped name rule reads it: the writer's own shape first,
    // else the one module declaring a shape of that name.
    const declared = shapes.declaredIds();
    if (module && declared.includes(canonicalTypeSchemaId(module, name))) return { $ref: canonicalTypeSchemaId(module, name) };
    const ids = declared.filter((id) => parseCanonicalTypeSchemaId(id)?.typeName === name);
    if (ids.length === 1) return { $ref: ids[0]! };
    return module ? { $ref: canonicalTypeSchemaId(module, name) } : undefined;
  };
  if (typeof value === "string") {
    const node = named(value);
    return node && { node, written: value };
  }
  if (!isObject(value)) return undefined;
  if (typeof value.$ref === "string") return { node: value, written };
  if (isObject(value.schema)) return { node: value.schema, written: isObject(written) ? written.schema : undefined };
  if (value.type || value.properties) return { node: value, written };
  if (isResolvedReference(value)) {
    const node = named(value.name, value.alias);
    return node && { node, written };
  }
  return undefined;
}

/** One comparison a kind makes, to be read once the graph settles. */
interface PendingComparison {
  readonly node: PairNode;
  /** The diagnostic a finding of `text` is, at the kind. */
  readonly render: (text: string) => AnalysisDiagnostic;
}

/** Every kind document's contract findings, once per kind. */
export function kindContractFindings(kinds: readonly ResourceManifest[], scope: KindContractScope): ReadFinding[] {
  const { defs, aliases, aliasesByModule, rootModules, shapes } = scope;
  const resolveDef: DefResolver = (kind, from) => {
    const moduleScope = moduleAliasScope(from?.metadata, aliases, aliasesByModule);
    return defs.resolve(kind) ?? defs.resolve(moduleScope.resolveKind(kind) ?? kind);
  };
  // A named shape the judged documents hold as written: a plain analysis's
  // documents hold them all, the union's kind documents none.
  const writtenShapes = new Map<string, unknown>();
  const declaredShapes = new Set(shapes.declaredIds());
  for (const m of kinds) {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    const name = m.metadata?.name;
    if (typeof module !== "string" || typeof name !== "string" || m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") continue;
    const id = canonicalTypeSchemaId(module, name);
    if (declaredShapes.has(id) && !writtenShapes.has(id)) writtenShapes.set(id, (m as Schema).schema);
  }
  const graph = new ContractPairGraph(shapes, defs, (id) => writtenShapes.get(id));
  const ordered: (ReadFinding | PendingComparison)[] = [];
  const always = (diagnostic: AnalysisDiagnostic) => ordered.push({ held: TRUE, render: () => [diagnostic] });

  const documents: ResourceManifest[] = [];
  const judged = new Set<string>();
  for (const m of kinds) {
    if (m.kind !== "Telo.Definition" && m.kind !== "Telo.Abstract") continue;
    const key = registryKey(m);
    if (key === undefined || judged.has(key)) continue;
    judged.add(key);
    documents.push(m);
  }
  /** A kind document as written, by registry key: what a label quotes. */
  const writtenByKey = new Map(documents.map((m) => [registryKey(m)!, m]));
  const writtenOf = (def: { metadata?: unknown }): Record<string, unknown> | undefined => {
    const key = registryKey(def);
    return key === undefined ? undefined : (writtenByKey.get(key) as Record<string, unknown> | undefined);
  };

  // A dependency's too, unlike the checks below: the kernel refuses such a
  // definition at registration, so staying silent only moves the failure to boot.
  for (const m of documents) {
    const def = m as unknown as ResourceDefinition;
    const violation = codesOutsideCeiling(def, resolveDef);
    if (!violation) continue;
    always({
      severity: DiagnosticSeverity.Error,
      code: "THROWS_NOT_SUBSTITUTABLE",
      source: SOURCE,
      message: throwsNotSubstitutableMessage(def, violation),
      data: {
        resource: { kind: m.kind, name: m.metadata?.name as string },
        filePath: (m.metadata as { source?: string } | undefined)?.source,
        path: `throws.codes.${violation.outside[0]}`,
      },
    });
  }

  for (const m of documents) {
    if (!isEntryOwned(m, rootModules)) continue;
    const name = m.metadata?.name as string;
    const filePath = (m.metadata as { source?: string } | undefined)?.source;
    const resource = { kind: m.kind, name };
    const report = (code: string, path: string, message: string): AnalysisDiagnostic => ({
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message,
      data: { resource, filePath, path },
    });
    // The canonical copy the registration holds: every reference to a named
    // shape an id in its declaring module.
    const key = registryKey(m)!;
    const own = (defs.resolve(key) ?? registeredDefinitionCopy(m, aliases, aliasesByModule)) as unknown as Record<string, unknown>;
    const def = own as unknown as ResourceDefinition;
    const ownModule = (m.metadata as { module?: string } | undefined)?.module;

    // A child that inherits its controller and REPLACES a contract must bridge it.
    for (const direction of ["inputType", "outputType"] as ContractDirection[]) {
      if (!needsContractMapping(def, resolveDef, direction)) continue;
      const mappingField = mappingFieldFor(direction);
      if (own[mappingField] != null) continue;
      always(
        report(
          "CONTRACT_MISSING_MAPPING",
          direction,
          `${m.kind}/${name}: declares its own \`${direction}\` but inherits its controller, ` +
            `and no \`${mappingField}:\` mapping bridges the two. The inherited controller only understands ` +
            `the kind it came from, so without a mapping the declaration would never be applied. Add a ` +
            `\`${mappingField}:\` mapping, or drop \`${direction}\` to inherit the contract unchanged.`,
        ),
      );
    }

    /** A side of a kind document's own comparison: its field's root. */
    const kindSide = (holder: Record<string, unknown>, field: string, value: unknown, module: string | undefined): CompatSide | undefined => {
      const writtenField = writtenOf(holder)?.[field];
      const found = contractRoot(value, writtenField, module, moduleAliasScope(holder.metadata as { module?: unknown } | undefined, aliases, aliasesByModule), shapes);
      if (!found) return undefined;
      const doc: CompatDocument & { written?: unknown } = { label: `${kindLabel(holder)} ${field}`, written: found.written };
      return { node: found.node, root: found.node, at: "#", doc };
    };

    // A REPLACING CONTRACT MUST STILL STAND IN FOR THE ONE IT REPLACES — only
    // an abstract ancestor's (see the analyzer guide's invocation contract).
    for (const direction of ["inputType", "outputType"] as ContractDirection[]) {
      const value = own[direction];
      if (value === undefined || value === null) continue;
      // A declared bridge says the shapes differ on purpose and are translated.
      if (own[mappingFieldFor(direction)] != null) continue;
      // The nearest ANCESTOR that declares it — the contract this one replaces.
      const ancestor = ancestorChain(def, resolveDef).find((a) => {
        const inherited = (a as unknown as Record<string, unknown>)[direction];
        return inherited !== undefined && inherited !== null;
      });
      if (!ancestor || ancestor.kind !== "Telo.Abstract") continue;
      const ancestorDoc = ancestor as unknown as Record<string, unknown>;
      const ownSide = kindSide(own, direction, value, ownModule);
      const ancestorSide = kindSide(ancestorDoc, direction, ancestorDoc[direction], (ancestor.metadata as { module?: string } | undefined)?.module);
      // An unresolvable side says nothing about compatibility; CONTRACT_TYPE_NOT_FOUND
      // is what reports a contract that names a type nothing declares.
      if (!ownSide || !ancestorSide) continue;
      const node = direction === "outputType" ? graph.root(ownSide, ancestorSide) : graph.root(ancestorSide, ownSide);
      const ancestorName = kindLabel(ancestor);
      const why =
        direction === "outputType"
          ? `every caller that holds this through '${ancestorName}' reads the shape that kind declares`
          : `a caller that holds this through '${ancestorName}' sends the shape that kind declares`;
      ordered.push({
        node,
        render: (text: string) =>
          report(
            "CONTRACT_NOT_SUBSTITUTABLE",
            direction,
            `${m.kind}/${name}: \`${direction}\` replaces the one declared by '${ancestorName}' ` +
              `with a shape that cannot stand in for it — ${text}. Contracts replace rather ` +
              `than merge, so nothing re-checks this at dispatch: ${why}. Restate the fields ` +
              `'${ancestorName}' declares, or drop \`${direction}\` to inherit the contract unchanged.`,
          ),
      });
    }

    // A REPLACING SIGNATURE MUST STILL STAND IN FOR THE ONE IT REPLACES — the
    // same rule over `params` (contravariant, positional and named) and
    // `returns` (covariant), and determinism.
    if (!isCallableKind(def, resolveDef)) continue;
    const replaced = (ancestorName: string): string =>
      ` Signatures replace rather than merge, so nothing re-checks this at a call site: every ` +
      `caller that reaches this function through '${ancestorName}' is checked against the ` +
      `signature THAT kind declares.`;
    for (const half of ["params", "returns"] as const) {
      const value = own[half];
      if (value === undefined || value === null) continue;
      const ancestor = signatureDeclarer(resolveParent(def, resolveDef), resolveDef, half);
      if (!ancestor || ancestor.kind !== "Telo.Abstract") continue;
      const ancestorName = kindLabel(ancestor);
      const inherited = ancestor as unknown as Record<string, unknown>;
      for (const item of signatureComparisons(own, inherited, { params: half === "params", returns: half === "returns" })) {
        if (!isSignatureComparison(item)) {
          const { path, text } = describeSignatureMismatch(item, ancestorName);
          always(report("CONTRACT_NOT_SUBSTITUTABLE", path, `${m.kind}/${name}: ${text}${replaced(ancestorName)}`));
          continue;
        }
        const slot = item.kind === "returns" ? "returns" : `params[${item.index}]`;
        const fromOwn = item.kind === "returns";
        const side = (schema: Schema, holder: Record<string, unknown>): CompatSide => ({
          node: schema,
          root: schema,
          at: "#",
          doc: { label: `${kindLabel(holder)} ${slot}` },
        });
        const node = graph.root(side(item.source, fromOwn ? own : inherited), side(item.target, fromOwn ? inherited : own));
        ordered.push({
          node,
          render: (text: string) => {
            const { path, text: sentence } = describeSignatureMismatch(
              item.kind === "returns" ? { kind: "returns", issues: [text] } : { kind: "parameter", index: item.index, name: item.name, issues: [text] },
              ancestorName,
            );
            return report("CONTRACT_NOT_SUBSTITUTABLE", path, `${m.kind}/${name}: ${sentence}${replaced(ancestorName)}`);
          },
        });
      }
    }

    // Determinism. Only a kind that supplies its own implementation can answer a
    // requirement; a controller-inheriting child inherits the claim with the
    // controller and is forbidden from restating it.
    if (m.kind === "Telo.Abstract" || !hasOwnControllerOrTemplate(def)) continue;
    if (claimsDeterministic(own)) continue;
    const requiring = ancestorChain(def, resolveDef).find((a) => a.kind === "Telo.Abstract" && claimsDeterministic(a));
    if (!requiring) continue;
    always(
      report(
        "CONTRACT_NOT_SUBSTITUTABLE",
        "deterministic",
        `${m.kind}/${name}: '${kindLabel(requiring)}' requires \`deterministic: true\` of every implementation, and this ` +
          `kind declares none — so it reads as non-deterministic. Determinism is a promise about ` +
          `native code and never flows down: an implementation makes the claim itself, or the ` +
          `abstract must stop requiring it.`,
      ),
    );
  }

  graph.solve();
  const out: ReadFinding[] = [];
  for (const entry of ordered) {
    if ("held" in entry) {
      out.push(entry);
      continue;
    }
    for (const finding of graph.findings(entry.node, shapes.source.universe)) {
      out.push({ held: finding.held, render: () => [entry.render(finding.text)] });
    }
  }
  return out;
}

/**
 * `SCHEMA_IN_PLACE_CYCLE` over every configuration at once: the in-place cycles
 * of the kind documents' schemas and of the named shapes, each one finding at
 * the declaration it starts from.
 *
 * The graph is the reader's (`schema-in-place-cycle.ts`) over reference nodes,
 * a named shape's nodes read per class through the named-shape reader, each
 * labelled by its class's condition. A cycle holds where the conditions of the
 * nodes closing it hold, and is found at its first node in written order:
 * where a node lies on a cycle of nodes written after it, by the reader's reach
 * fixpoint over that strongly connected part alone. A document's finding holds
 * where any cycle found at one of its nodes does.
 *
 * A shape of a library imported more than once is read as the classes of
 * every instance (`NamedShapeReader.classes`), never one instance's: a kind
 * document is one document for every instance of its module, so what it finds
 * through a shape holds where some instance reads that class.
 *
 * Browser-safe.
 */
import { parseCanonicalTypeSchemaId, type ResourceManifest } from "@telorun/sdk";
import type { KindDocumentScope } from "./document-findings.js";
import { kindDeclarationOf } from "./kind-declaration.js";
import { kindDocumentProblemDiagnostic } from "./kind-document-problem.js";
import { declaringModuleScope } from "./module-alias-scope.js";
import type { ShapeClass } from "./named-shape-reader.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { canonicalShapeSchema, withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { frozenWalkSchema } from "./frozen-kind-schema.js";
import { isModuleKind } from "./module-kinds.js";
import type { ImportReach } from "./reaching-import.js";
import {
  danglingLocalReferences,
  definitionSchemaDocuments,
  localInPlaceCycles,
  moduleInputSchemaDocuments,
  type DanglingLocalReference,
  type SchemaDocument,
} from "./validated-schemas.js";
import { needTypeOf } from "./need-type.js";
import {
  canonicalPointer,
  inPlaceCycleMessage,
  inPlaceReferences,
  SCHEMA_IN_PLACE_CYCLE,
  writtenReferences,
  type InPlaceHop,
  type InPlaceTarget,
} from "./schema-in-place-cycle.js";
import { schemaReferenceParts } from "./schema-reference.js";
import type { ReadFinding } from "./union-passes.js";
import type { WorldReader } from "./world-reader.js";
import type { AnalysisDiagnostic } from "./types.js";

type Schema = Record<string, any>;

/** A document of the graph: a kind document's schema field, or a named shape
 *  read by its classes. */
interface Document {
  readonly key: string;
  readonly classes: readonly Pick<ShapeClass, "index" | "condition" | "schema">[];
  /** Where a cycle found here is reported. */
  report(read: WorldReader<Condition>, message: (owner: string, label: (document: string) => string) => string): AnalysisDiagnostic[];
  /** The document's name in a message read from `from`. */
  readonly label: (from: string | undefined) => string;
  readonly module: string | undefined;
}

interface Node {
  readonly key: string;
  readonly order: number;
  readonly document: Document;
  readonly classIndex: number;
  readonly condition: Condition;
  readonly at: string;
  readonly ref: string;
}

const nodeKey = (document: string, classIndex: number, at: string): string => JSON.stringify([document, classIndex, at]);

export function schemaInPlaceCycleFindings(kinds: readonly ResourceManifest[], scope: KindDocumentScope): ReadFinding[] {
  const { shapes, reach } = scope;
  const { space } = shapes;
  const compileScope = { defs: scope.defs, aliases: scope.aliases, aliasesByModule: scope.aliasesByModule, rootModules: new Set(scope.rootModules) };
  /** `schema` canonical in `module`, as the registry holds a kind's. */
  const canonicalIn = (schema: Schema, module: string | undefined): Schema => {
    if (!module) return schema;
    const moduleScope = declaringModuleScope(module, scope.aliases, compileScope);
    const moduleForAlias = (alias: string) => moduleScope.moduleForAlias(alias);
    return canonicalShapeSchema(withCanonicalRefSentinels(schema, module, moduleForAlias) as Schema, module, moduleForAlias);
  };

  const documents: Document[] = [];
  const byKey = new Map<string, Document>();
  const add = (document: Document) => {
    documents.push(document);
    byKey.set(document.key, document);
  };
  const shapeLabel = (id: string) => (from: string | undefined) => {
    const named = parseCanonicalTypeSchemaId(id);
    if (!named) return id;
    return named.moduleName === from ? named.typeName : `${named.moduleName}.${named.typeName}`;
  };

  const judged = new Set<string>();
  // A need type's documents are validated alone, so a local reference naming
  // nothing in one is refused there; a kind's `schema:` is the compile pass's.
  const dangling: AnalysisDiagnostic[] = [];
  for (const m of kinds) {
    const definition = kindDeclarationOf(m);
    if (!definition) continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    const name = String(m.metadata?.name);
    const identity = JSON.stringify([module ?? "", name]);
    if (judged.has(identity)) continue;
    judged.add(identity);
    if (needTypeOf(definition)) {
      for (const problem of danglingReferenceProblems(name, definitionSchemaDocuments(definition))) {
        dangling.push(kindDocumentProblemDiagnostic(m, module, problem, reach));
      }
    }
    for (const { path, schema } of definitionSchemaDocuments(definition)) {
      const key = JSON.stringify(["kind", module ?? "", name, path]);
      add({
        key,
        module,
        classes: [{ index: 0, condition: TRUE, schema: (module && path === "schema" && frozenWalkSchema(scope.defs, m)) || canonicalIn(schema, module) }],
        label: () => path,
        report: (_read, message) => [
          kindDocumentProblemDiagnostic(m, module, { code: SCHEMA_IN_PLACE_CYCLE, path, message: message(`'${name}'`, labelOf(module)) }, reach),
        ],
      });
    }
  }
  for (const id of shapes.declaredIds()) {
    const named = parseCanonicalTypeSchemaId(id);
    if (!named) continue;
    add({
      key: id,
      module: named.moduleName,
      // A library's shape is read as written there; its references are read
      // canonical in its module, as every other document's.
      classes: shapes.classes(id).map((each) => ({ ...each, schema: canonicalIn(each.schema, named.moduleName) })),
      label: shapeLabel(id),
      report: (read, message) => {
        const declared =
          shapes.declarationsOf(id).find((declaration) => read.holds(declaration.condition))?.manifest ??
          scope.moduleDocuments
            .find((library) => library.module === named.moduleName)
            ?.manifests.find((doc) => doc.metadata?.name === named.typeName && doc.schema !== undefined);
        if (!declared) return [];
        const text = message(`'${named.typeName}'`, labelOf(named.moduleName));
        return [kindDocumentProblemDiagnostic(declared, named.moduleName, { code: SCHEMA_IN_PLACE_CYCLE, path: "schema", message: text }, reach)];
      },
    });
  }
  function labelOf(from: string | undefined): (key: string) => string {
    return (key) => byKey.get(key)?.label(from) ?? key;
  }

  // Every reference node, in written order.
  const nodes = new Map<string, Node>();
  const ordered: Node[] = [];
  for (const document of documents) {
    for (const each of document.classes) {
      for (const { at, ref } of writtenReferences(each.schema)) {
        const node: Node = {
          key: nodeKey(document.key, each.index, at),
          order: ordered.length,
          document,
          classIndex: each.index,
          condition: each.condition,
          at,
          ref,
        };
        nodes.set(node.key, node);
        ordered.push(node);
      }
    }
  }

  /** Where a node's reference lands. */
  const targetOf = (node: Node): (InPlaceTarget & { sameClass: boolean }) | undefined => {
    const { shape, pointer } = schemaReferenceParts(node.ref);
    if (shape === undefined) return { document: node.document.key, pointer: canonicalPointer(pointer), sameClass: true };
    if (!shapes.isShapeId(shape) || !byKey.has(shape)) return undefined;
    return { document: shape, pointer: canonicalPointer(pointer), sameClass: false };
  };
  const successorMemo = new Map<string, { node: Node; condition: Condition; hop: InPlaceHop }[]>();
  const successors = (node: Node) => {
    const known = successorMemo.get(node.key);
    if (known) return known;
    const out: { node: Node; condition: Condition; hop: InPlaceHop }[] = [];
    const target = targetOf(node);
    if (target) {
      const document = byKey.get(target.document)!;
      const hop: InPlaceHop = { document: node.document.key, at: node.at, ref: node.ref, target };
      const classes = target.sameClass ? document.classes.filter((each) => each.index === node.classIndex) : document.classes;
      for (const each of classes) {
        for (const { at } of inPlaceReferences(each.schema, target.pointer)) {
          const next = nodes.get(nodeKey(document.key, each.index, at));
          if (next) out.push({ node: next, condition: target.sameClass ? TRUE : each.condition, hop });
        }
      }
    }
    successorMemo.set(node.key, out);
    return out;
  };

  const components = cyclicComponents(ordered, (node) => successors(node).map((edge) => edge.node));

  // Each node's cycles among the nodes written after it, labelled.
  const cycleCondition = new Map<string, Condition>();
  for (const node of ordered) {
    const component = components.get(node.key);
    if (component === undefined) continue;
    const within = (next: Node) => components.get(next.key) === component && next.order >= node.order;
    const reached = shapes.reachOver(
      successors(node)
        .filter((edge) => within(edge.node))
        .map((edge) => ({ node: edge.node, condition: space.and(node.condition, edge.condition) })),
      (from) => (from.key === node.key ? [] : successors(from).filter((edge) => within(edge.node))),
      (each) => each.key,
    );
    const held = reached.get(node.key)?.condition ?? FALSE;
    if (held !== FALSE) cycleCondition.set(node.key, held);
  }

  /** The hops of a cycle from `start` back to it among the nodes written after
   *  it, every node and edge holding where `read` does. */
  const cycleAt = (start: Node, read: WorldReader<Condition>): InPlaceHop[] | undefined => {
    const parent = new Map<string, { from: string; hop: InPlaceHop }>();
    const queue: Node[] = [start];
    const seen = new Set<string>([start.key]);
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const edge of successors(node)) {
        if (edge.node.order < start.order || !read.holds(edge.condition) || !read.holds(edge.node.condition)) continue;
        if (edge.node.key === start.key) {
          const hops = [edge.hop];
          let at = node.key;
          while (at !== start.key) {
            const step = parent.get(at)!;
            hops.unshift(step.hop);
            at = step.from;
          }
          return hops;
        }
        if (seen.has(edge.node.key)) continue;
        seen.add(edge.node.key);
        parent.set(edge.node.key, { from: node.key, hop: edge.hop });
        queue.push(edge.node);
      }
    }
    return undefined;
  };

  const out: ReadFinding[] = dangling.map((diagnostic) => ({ held: TRUE, render: () => [diagnostic] }));
  for (const document of documents) {
    const own = ordered.filter((node) => node.document === document && cycleCondition.has(node.key));
    if (own.length === 0) continue;
    const held = space.some(own.map((node) => cycleCondition.get(node.key)!));
    if (held === FALSE) continue;
    out.push({
      held,
      render: (read) => {
        for (const node of own) {
          if (!read.holds(cycleCondition.get(node.key)!)) continue;
          const hops = cycleAt(node, read);
          if (!hops) continue;
          return document.report(read, (owner, label) => inPlaceCycleMessage(owner, hops, label));
        }
        return [];
      },
    });
  }
  return out;
}

/** The code a schema no validator can compile is refused with. */
const SCHEMA_COMPILE_ERROR = "SCHEMA_COMPILE_ERROR";

/** One `SCHEMA_COMPILE_ERROR` per local reference of `documents` naming no node
 *  of the document it is written in, at the reference, owned by `name`. */
function danglingReferenceProblems(name: string, documents: readonly SchemaDocument[]) {
  return danglingLocalReferences(documents).map((reference: DanglingLocalReference) => ({
    code: SCHEMA_COMPILE_ERROR,
    path: `${reference.path}${reference.keys.map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("")}.$ref`,
    message:
      `'${name}': the schema at '${reference.path}' does not compile: its $ref '${reference.ref}' names no node of it. ` +
      `A '#' reference is read from the root of '${reference.path}', which is a schema of its own.`,
  }));
}

/**
 * `SCHEMA_IN_PLACE_CYCLE` for each `variables:` / `secrets:` entry of a module
 * document whose schema recurses in place through its own references — an
 * entry is a document of its own, which nothing else references — and
 * `SCHEMA_COMPILE_ERROR` for each local reference in one naming nothing in it,
 * which the kernel cannot compile when it validates the entry. With
 * `libraries` unset the entry's own modules' are judged, at the entry; with it
 * set, the imported libraries', each at the entry's `imports:` entry first
 * reaching it, since the kernel refuses the import all the same — a library no
 * import reaches is its own check's.
 */
export function moduleInputCycleDiagnostics(
  documents: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
  reach: ImportReach,
  libraries = false,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  for (const m of documents) {
    if (!isModuleKind(m.kind)) continue;
    const name = String(m.metadata?.name ?? "");
    if (libraries ? rootModules.has(name) || !reach.of(name) : !rootModules.has(name)) continue;
    const documents = moduleInputSchemaDocuments(m);
    for (const { path, cycle } of localInPlaceCycles(documents)) {
      const message = inPlaceCycleMessage(`'${name}'`, cycle, (document) => document);
      out.push(kindDocumentProblemDiagnostic(m, name, { code: SCHEMA_IN_PLACE_CYCLE, path, message }, reach));
    }
    for (const problem of danglingReferenceProblems(name, documents)) out.push(kindDocumentProblemDiagnostic(m, name, problem, reach));
  }
  return out;
}

/**
 * The nodes lying on a cycle of the unlabelled graph, each mapped to its
 * strongly connected component — Tarjan's algorithm, iterative. A component of
 * one node is cyclic only when the node is its own successor.
 */
function cyclicComponents<N extends { key: string }>(nodes: readonly N[], successors: (node: N) => readonly N[]): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: N[] = [];
  const out = new Map<string, number>();
  let counter = 0;
  let component = 0;
  for (const root of nodes) {
    if (index.has(root.key)) continue;
    const work: { node: N; next: number; successors: readonly N[] }[] = [];
    const open = (node: N) => {
      index.set(node.key, counter);
      low.set(node.key, counter);
      counter++;
      stack.push(node);
      onStack.add(node.key);
      work.push({ node, next: 0, successors: successors(node) });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.next < frame.successors.length) {
        const next = frame.successors[frame.next++]!;
        if (!index.has(next.key)) open(next);
        else if (onStack.has(next.key)) low.set(frame.node.key, Math.min(low.get(frame.node.key)!, index.get(next.key)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node.key, Math.min(low.get(parent.node.key)!, low.get(frame.node.key)!));
      if (low.get(frame.node.key) !== index.get(frame.node.key)) continue;
      const members: N[] = [];
      let member: N;
      do {
        member = stack.pop()!;
        onStack.delete(member.key);
        members.push(member);
      } while (member.key !== frame.node.key);
      const selfLoop = members.length === 1 && frame.successors.some((each) => each.key === frame.node.key);
      if (members.length > 1 || selfLoop) for (const each of members) out.set(each.key, component);
      component++;
    }
  }
  return out;
}

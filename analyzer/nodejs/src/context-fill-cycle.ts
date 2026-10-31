/**
 * `x-telo-context-item-fills: [<pointer>…]` and `CONTEXT_FILL_CYCLE`.
 *
 * The annotation sits on a binding of a region declared on a LIST, and says
 * which member of that binding each item of the list fills: the first pointer,
 * read from the item, that yields a literal string (`""` the item itself, so a
 * bare name fills that name; `/property` the item's `property`, read through
 * the declaration a reference names). A form's `fields` bind `values` this way.
 *
 * An item DEPENDS on member `q` when an accessor chain rooted at the binding —
 * written in the item, or in a resource it reaches whose binding is forwarded
 * from it (`x-telo-context-from-referrer`) — names `q` first. Items depending on
 * each other in a cycle (one on itself included) can never be entered in turn,
 * so each read forming such a dependency is `CONTEXT_FILL_CYCLE`: computed over
 * the binding flow, strongly connected components found once per binding
 * origin, linear in items plus reads.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";
import { nodeIdFor, type CallGraph } from "./call-graph.js";
import { readFromReferrer } from "./context-from-referrer.js";
import type { NamedShapeLookup } from "./eval-paths.js";
import { contextChainAt, extractContextsFromSchema } from "./validate-cel-context.js";
import { resolveScopeValues } from "./value-schema-slot.js";
import { READS_IDENTITY, type ReadReporter } from "./read-place.js";

export const ITEM_FILLS = "x-telo-context-item-fills";

/** The pointers a binding's annotation names, or undefined when it is absent or
 *  malformed (which the strict half reports). */
export function readItemFills(binding: unknown): readonly string[] | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const value = (binding as Record<string, unknown>)[ITEM_FILLS];
  return itemFillsValueProblem(value) === undefined ? (value as string[]) : undefined;
}

/** Why a written value is no non-empty list of pointers. */
export function itemFillsValueProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return "it must be a non-empty list of JSON Pointers";
  const bad = value.find((p) => typeof p !== "string" || (p !== "" && !p.startsWith("/")));
  return bad === undefined ? undefined : `'${String(bad)}' is no JSON Pointer — write '' for the item itself or '/<field>'`;
}

/** What the pass needs from its host. */
export interface FillCycleHost {
  readonly graph: CallGraph;
  readonly shapes: NamedShapeLookup;
  /** A resource's kind, resolved in its module's scope. */
  definitionOf(m: ResourceManifest): ResourceDefinition | undefined;
  /** The author schema of a definition, inheritance resolved. */
  schemaOf(definition: ResourceDefinition | undefined): Record<string, any> | undefined;
}

/** One read forming a cycle, where it is written and what it says. */
export interface FillCycleFinding {
  readonly manifest: ResourceManifest;
  readonly path: string;
  readonly message: string;
}

interface Read {
  readonly item: number;
  readonly member: string;
  readonly manifest: ResourceManifest;
  readonly path: string;
  readonly chain: string;
}

const PLAIN_CHAIN = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*$/;

function* celLeaves(value: unknown, path: string): Generator<{ path: string; source: string }> {
  if (isTaggedSentinel(value)) {
    if (value.engine === CEL_ENGINE) yield { path, source: value.source.trim() };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* celLeaves(value[i], `${path}[${i}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (path === "" && (key === "kind" || key === "metadata")) continue;
    yield* celLeaves(child, path === "" ? key : `${path}.${key}`);
  }
}

const valueAt = (root: unknown, pointer: string): unknown => {
  if (pointer === "") return root;
  let node = root;
  for (const segment of pointer.slice(1).split("/")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
};

/** Every read forming a fill cycle in `owner`'s lists. */
export function contextFillCycles(owner: ResourceManifest, host: FillCycleHost): FillCycleFinding[] {
  const schema = host.schemaOf(host.definitionOf(owner));
  if (!schema) return [];
  const regions = extractContextsFromSchema(schema, host.shapes);
  const findings: FillCycleFinding[] = [];
  const contextsOf = new Map<ResourceManifest, ReturnType<typeof extractContextsFromSchema>>();
  const regionsOf = (m: ResourceManifest) => {
    let found = contextsOf.get(m);
    if (!found) {
      const own = host.schemaOf(host.definitionOf(m));
      contextsOf.set(m, (found = own ? extractContextsFromSchema(own, host.shapes) : []));
    }
    return found;
  };
  const ownersAt = (m: ResourceManifest, path: string): Map<string, unknown> => {
    const owners = new Map<string, unknown>();
    for (const region of contextChainAt(regionsOf(m), path)) {
      for (const [name, binding] of Object.entries((region.schema.properties ?? {}) as Record<string, unknown>)) {
        owners.set(name, binding);
      }
    }
    return owners;
  };
  const targetOf = (m: ResourceManifest, path: string): ResourceManifest | undefined => {
    for (const edge of host.graph.edgesFrom(nodeIdFor(m))) {
      if (edge.path !== path || edge.moduleCall || !edge.to) continue;
      const node = host.graph.nodes.get(edge.to);
      if (node?.type === "resource") return node.manifest;
    }
    return undefined;
  };

  for (const region of regions) {
    for (const [binding, declared] of Object.entries((region.schema.properties ?? {}) as Record<string, unknown>)) {
      const pointers = readItemFills(declared);
      if (!pointers) continue;
      for (const { path: listPath, value: list } of resolveScopeValues(owner as Record<string, any>, region.scope)) {
        if (!Array.isArray(list)) continue;
        const fills: (string | undefined)[] = list.map((item, i) => {
          const declaration = targetOf(owner, `${listPath}[${i}]`) ?? item;
          for (const pointer of pointers) {
            const filled = valueAt(pointer === "" ? item : declaration, pointer);
            if (typeof filled === "string") return filled;
          }
          return undefined;
        });
        const reads: Read[] = [];
        const readsIn = (
          item: number,
          m: ResourceManifest,
          prefix: string,
          value: unknown,
          carriers: (name: string, holder: unknown) => boolean,
          seen: Set<ResourceManifest>,
        ): void => {
          for (const leaf of celLeaves(value, prefix)) {
            const chain = PLAIN_CHAIN.exec(leaf.source);
            if (!chain) continue;
            const holder = ownersAt(m, leaf.path).get(chain[1]!);
            if (!carriers(chain[1]!, holder)) continue;
            reads.push({ item, member: chain[2]!, manifest: m, path: leaf.path, chain: leaf.source });
          }
          for (const edge of host.graph.edgesFrom(nodeIdFor(m))) {
            if (edge.moduleCall || !edge.to || (prefix !== "" && edge.path !== prefix && !edge.path.startsWith(`${prefix}.`) && !edge.path.startsWith(`${prefix}[`))) continue;
            const node = host.graph.nodes.get(edge.to);
            if (node?.type !== "resource" || seen.has(node.manifest)) continue;
            // The names the referent's bindings forward: those in scope at the
            // slot that carry the origin's record.
            const forwarded = new Set(
              [...ownersAt(m, edge.path)].filter(([name, holder]) => carriers(name, holder)).map(([name]) => name),
            );
            if (forwarded.size === 0) continue;
            readsIn(
              item,
              node.manifest,
              "",
              node.manifest,
              (_name, holder) => {
                const from = readFromReferrer(holder);
                return from !== undefined && forwarded.has(from);
              },
              new Set([...seen, node.manifest]),
            );
          }
        };
        list.forEach((item, i) =>
          readsIn(
            i,
            owner,
            `${listPath}[${i}]`,
            item,
            (name, holder) => name === binding && readItemFills(holder) !== undefined,
            new Set([owner]),
          ),
        );

        // Strongly connected components over items, edges read → filler.
        const fillers = new Map<string, number[]>();
        fills.forEach((member, i) => {
          if (member === undefined) return;
          const list2 = fillers.get(member) ?? [];
          list2.push(i);
          fillers.set(member, list2);
        });
        const adjacency: number[][] = list.map(() => []);
        for (const read of reads) for (const j of fillers.get(read.member) ?? []) adjacency[read.item]!.push(j);
        const component = stronglyConnected(adjacency);
        const sizes = new Map<number, number>();
        for (const c of component) sizes.set(c, (sizes.get(c) ?? 0) + 1);
        for (const read of reads) {
          for (const j of fillers.get(read.member) ?? []) {
            const c = component[read.item]!;
            if (c !== component[j] || (sizes.get(c) === 1 && read.item !== j)) continue;
            const members = fills.filter((_, k) => component[k] === c && fills[k] !== undefined) as string[];
            const anchored = isForeign(read.manifest, owner)
              ? { manifest: owner, path: `${listPath}[${read.item}]` }
              : { manifest: read.manifest, path: read.path };
            findings.push({
              ...anchored,
              message:
                `'${read.chain}' makes ${describe(fills[read.item], read.item, listPath)} depend on '${read.member}', ` +
                `which ${read.item === j ? "it fills itself" : describe(fills[j], j, listPath) + " fills"}, so the entries of ` +
                `'${listPath}' depend on each other in a cycle (${[...new Set(members)].join(" → ")} → ${members[0]}) ` +
                `and none can be entered first. Read a member no entry of the cycle fills.`,
            });
            break;
          }
        }
      }
    }
  }
  return findings;
}

const describe = (member: string | undefined, index: number, list: string) =>
  member === undefined ? `'${list}[${index}]'` : `the entry filling '${member}'`;

/** A resource declared in another module than the owner. */
function isForeign(m: ResourceManifest, owner: ResourceManifest): boolean {
  const module = (m.metadata as { module?: string } | undefined)?.module;
  const own = (owner.metadata as { module?: string } | undefined)?.module;
  return module !== own;
}

/** Tarjan's algorithm: the component index of each node. */
function stronglyConnected(adjacency: readonly number[][]): number[] {
  const index: number[] = adjacency.map(() => -1);
  const low: number[] = adjacency.map(() => 0);
  const onStack: boolean[] = adjacency.map(() => false);
  const component: number[] = adjacency.map(() => -1);
  const stack: number[] = [];
  let next = 0;
  let count = 0;
  const visit = (v: number): void => {
    index[v] = low[v] = next++;
    stack.push(v);
    onStack[v] = true;
    for (const w of adjacency[v]!) {
      if (index[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) {
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        component[w] = count;
      } while (w !== v);
      count++;
    }
  };
  for (let v = 0; v < adjacency.length; v++) if (index[v] === -1) visit(v);
  return component;
}

/** What `x-telo-context-item-fills` reads: every item of the list the region is
 *  declared on — what its members fill is decided by the items, a declaration
 *  they name by its identity. */
export const itemFillsReads: ReadReporter = ({ at }) => [{ kind: "reference", keys: at, transitive: false, reads: READS_IDENTITY }];

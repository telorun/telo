/**
 * Which schema nodes can reach a node carrying a given mark — so a walk looking
 * for that mark skips every subtree that cannot hold one.
 *
 * The contract walks (`sensitivePaths`, `spanAttributePaths`) guard against a
 * cycle only along the path being walked, so a named shape reachable along many
 * paths is walked once per path, and a recursive union is walked once per path
 * through it. This answers, once per walk and in time linear in the schema graph,
 * whether a node can lead to the mark at all. It over-approximates the walk's own
 * edges (it ignores where the walk stops a reference chain or a live value), so a
 * subtree it rules out holds no mark the walk could have reached: pruning by it
 * changes no result.
 */
import { resolveRefIn, type ExternalSchemaResolver } from "./schema-compat.js";

/** Whether `node`, walked against `document`, can lead to a marked node. */
export type MarkReach = (node: unknown, document: Record<string, any>) => boolean;

const BRANCH_LISTS = ["allOf", "anyOf", "oneOf"] as const;

/** Past this many distinct (node, document) pairs the graph is not built and
 *  nothing is pruned, which is what the walks did before. */
const NODE_BUDGET = 200_000;

const reachesEverything: MarkReach = () => true;

export function markReach(
  schema: Record<string, any>,
  resolveRef: ExternalSchemaResolver | undefined,
  mark: string,
): MarkReach {
  const ids = new Map<object, Map<object, number>>();
  const entries: Array<{ node: object; document: Record<string, any> }> = [];
  const reverse: number[][] = [];
  const marked: number[] = [];
  const pending: number[] = [];

  const idOf = (node: object, document: Record<string, any>): number => {
    let byDocument = ids.get(node);
    if (!byDocument) ids.set(node, (byDocument = new Map()));
    let id = byDocument.get(document);
    if (id === undefined) {
      id = entries.length;
      byDocument.set(document, id);
      entries.push({ node, document });
      reverse.push([]);
      pending.push(id);
    }
    return id;
  };
  const lookup = (node: object, document: object): number | undefined => ids.get(node)?.get(document);

  /** The document the walk descends in once `node`'s reference chain is followed. */
  const chainDocument = (node: Record<string, any>, document: Record<string, any>): Record<string, any> => {
    const seen = new Set<object>();
    let at = node;
    let root = document;
    while (typeof at.$ref === "string" && !seen.has(at)) {
      seen.add(at);
      const next = resolveRefIn(at, root, resolveRef);
      if (next.schema === at) break;
      at = next.schema;
      root = next.root;
    }
    return root;
  };

  idOf(schema, schema);
  while (pending.length > 0) {
    if (entries.length > NODE_BUDGET) return reachesEverything;
    const id = pending.pop()!;
    const { node, document } = entries[id]!;
    const edge = (child: unknown, childDocument: Record<string, any>): void => {
      if (child && typeof child === "object") reverse[idOf(child, childDocument)]!.push(id);
    };
    if (Array.isArray(node)) {
      for (const item of node) edge(item, document);
      continue;
    }
    const s = node as Record<string, any>;
    if (Object.hasOwn(s, mark)) marked.push(id);
    let descend = document;
    if (typeof s.$ref === "string") {
      const target = resolveRefIn(s, document, resolveRef);
      if (target.schema !== s) {
        edge(target.schema, target.root);
        descend = chainDocument(target.schema, target.root);
      }
    }
    const properties = s.properties;
    if (properties && typeof properties === "object") {
      for (const child of Object.values(properties)) edge(child, descend);
    }
    for (const branch of BRANCH_LISTS) {
      const list = s[branch];
      if (Array.isArray(list)) for (const child of list) edge(child, descend);
    }
    edge(s.additionalProperties, descend);
    const patterns = s.patternProperties;
    if (patterns && typeof patterns === "object") {
      for (const child of Object.values(patterns)) edge(child, descend);
    }
    for (const child of [s.items].flat()) edge(child, descend);
  }

  const reaches = new Uint8Array(entries.length);
  const queue = [...marked];
  for (const id of queue) reaches[id] = 1;
  while (queue.length > 0) {
    for (const from of reverse[queue.pop()!]!) {
      if (reaches[from]) continue;
      reaches[from] = 1;
      queue.push(from);
    }
  }

  return (node, document) => {
    if (!node || typeof node !== "object") return false;
    const id = lookup(node, document);
    return id === undefined || reaches[id] === 1;
  };
}

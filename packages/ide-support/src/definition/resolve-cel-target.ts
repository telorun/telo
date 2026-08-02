import {
  CelParseError,
  type CelNode,
  type CelSegment,
  type LoadedGraph,
  type LoadedModule,
} from "@telorun/analyzer";
import type { DefinitionResult } from "../types.js";
import {
  locateImport,
  locateModuleDocKey,
  locateResource,
  moduleFiles,
} from "./manifest-navigation.js";
import { resolveExportedResource } from "./resolve-export-chain.js";

/** Root CEL scopes whose members are declared as a block on the module doc, so
 *  `variables.port` navigates to `variables:` and then to its `port:` entry. */
const DECLARATION_SCOPES = new Set(["variables", "secrets", "ports"]);

/** One identifier of a dotted CEL chain, with the span the cursor hit-tests
 *  against. */
interface ChainPart {
  name: string;
  range: [number, number];
}

/** Flatten `a.b.c` into its identifiers. Returns undefined as soon as the chain
 *  is rooted in something other than a plain identifier (a call, an index), so a
 *  navigable prefix is never invented out of a computed expression. */
function flattenChain(node: CelNode): ChainPart[] | undefined {
  if (node.kind === "ident") return [{ name: node.name, range: node.range }];
  if (node.kind !== "member") return undefined;
  const head = flattenChain(node.target);
  return head ? [...head, { name: node.property, range: node.propertyRange }] : undefined;
}

/** Exhaustive by construction: a new `CelNode` variant fails the build here
 *  rather than silently going unwalked, so the analyzer's node model and this
 *  walk cannot drift apart unnoticed. */
function celChildren(node: CelNode): CelNode[] {
  switch (node.kind) {
    case "literal":
    case "ident":
      return [];
    case "member":
      return [node.target];
    case "index":
      return [node.target, node.index];
    case "call":
      return node.args;
    case "methodCall":
      return [node.receiver, ...node.args];
    case "list":
      return node.items;
    case "map":
      return node.entries.flatMap((e) => [e.key, e.value]);
    case "ternary":
      return [node.cond, node.then, node.else];
    case "unary":
      return [node.operand];
    case "binary":
      return [node.left, node.right];
  }
  const unhandled: never = node;
  throw new Error(`Unhandled CEL node: ${JSON.stringify(unhandled)}`);
}

/** The dotted chain under `offset`, and which of its identifiers was hit. The
 *  walk is outermost-first so the longest chain wins — `resources.Store.conn`
 *  resolves as one chain rather than as its `resources.Store` prefix. */
function chainAt(
  node: CelNode,
  offset: number,
): { parts: ChainPart[]; index: number } | undefined {
  if (offset < node.range[0] || offset > node.range[1]) return undefined;
  const parts = flattenChain(node);
  if (parts) {
    const index = parts.findIndex((p) => offset >= p.range[0] && offset <= p.range[1]);
    if (index >= 0) return { parts, index };
  }
  for (const child of celChildren(node)) {
    const hit = chainAt(child, offset);
    if (hit) return hit;
  }
  return undefined;
}

/** `resources.<name>` is a local instance; `resources.<Alias>.<name>` is an
 *  imported module's exported one. A local name wins over an import alias, so a
 *  deeper access on a local instance (`resources.db.url`) reads as a field of
 *  that instance rather than as a cross-module lookup. */
function resolveResourceChain(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  parts: ChainPart[],
  index: number,
): DefinitionResult | undefined {
  if (index === 0) return undefined;
  const first = parts[1].name;

  const local = locateResource(moduleFiles(currentModule), first);
  if (local) return index === 1 ? local : undefined;

  const edge = graph.importEdges.get(currentModule.owner.source)?.get(first);
  if (!edge) return undefined;
  if (index === 1) return locateImport(currentModule, first);
  if (index === 2) return resolveExportedResource(graph, edge.targetSource, parts[2].name);
  return undefined;
}

/** Resolve the CEL identifier under the cursor to where it is declared.
 *
 *  `variables` / `secrets` / `ports` navigate to their block on the module doc,
 *  and their member to that block's entry. `resources` navigates through the
 *  same instance lookup a `!ref` uses. Anything else (a step result, a handler
 *  scope like `request`, a member of a resolved value) has no manifest
 *  declaration to jump to and resolves to nothing.
 *
 *  A body the author is still writing may not parse; that means there is no
 *  chain to hit-test, not an error to surface from a navigation request — the
 *  analyzer reports the syntax error itself. Only that failure is tolerated: a
 *  defect in the CEL wrapper propagates rather than reading as "nothing to
 *  navigate to". */
export function resolveCelTarget(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  segment: CelSegment,
  offset: number,
): DefinitionResult | undefined {
  let ast: CelNode;
  try {
    ast = segment.ast();
  } catch (error) {
    if (!(error instanceof CelParseError)) throw error;
    return undefined;
  }

  const hit = chainAt(ast, offset);
  if (!hit) return undefined;
  const { parts, index } = hit;
  const root = parts[0].name;

  if (DECLARATION_SCOPES.has(root)) {
    if (index === 0) return locateModuleDocKey(currentModule, root);
    if (index === 1) return locateModuleDocKey(currentModule, `${root}.${parts[1].name}`);
    return undefined;
  }
  if (root === "resources") return resolveResourceChain(graph, currentModule, parts, index);
  return undefined;
}

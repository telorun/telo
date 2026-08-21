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
import { chainAt, type ChainPart } from "../cel-chain.js";

/** Root CEL scopes whose members are declared as a block on the module doc, so
 *  `variables.port` navigates to `variables:` and then to its `port:` entry. */
const DECLARATION_SCOPES = new Set(["variables", "secrets", "ports"]);

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
export interface CelTargetResolvers {
  /** Where a step of the CURRENT resource is declared. Supplied by the caller
   *  because finding one needs the declaring kind's step-body annotation, which
   *  the graph alone does not carry. */
  locateStep?(stepName: string): DefinitionResult | undefined;
  /** Where a context binding (`request.query`, `self.<field>`,
   *  `result.<field>`) was declared. Same reason: the site is derived by an
   *  `x-telo-context-*` annotation, which only the scope query can read. */
  locateContextBinding?(parts: string[]): DefinitionResult | undefined;
}

export function resolveCelTarget(
  graph: LoadedGraph,
  currentModule: LoadedModule,
  segment: CelSegment,
  offset: number,
  resolvers?: CelTargetResolvers,
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
  // `steps.<name>` navigates to the step; `steps` itself and `.result` do not —
  // the first names no one step, the second is the contract's output, which is
  // declared by the invoked target rather than at the read site.
  if (root === "steps" && index === 1 && resolvers?.locateStep) {
    return resolvers.locateStep(parts[1].name);
  }
  // Anything else in scope came from an `x-telo-context-*` annotation, which
  // names a real manifest node for `request` / `self` / `result` and friends.
  // The chain UP TO the cursor is what resolves — hovering `query` in
  // `request.query.lastEventId` navigates to `query`, not to the leaf.
  if (index >= 1 && resolvers?.locateContextBinding) {
    return resolvers.locateContextBinding(parts.slice(0, index + 1).map((p) => p.name));
  }
  return undefined;
}

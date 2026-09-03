import type { GraphNode, GraphPort, ModuleGraph } from "@telorun/analyzer";
import type { RefResolver } from "../../../resource-schema-form/ref-candidates";
import { handleId } from "./graph-nodes";

/**
 * Wiring by drag: which slot a gesture started from, and whether it may end
 * where it was dropped.
 *
 * The rule is the slot's own declared constraint, resolved through the registry
 * — the same `x-telo-ref` the checker validates the written reference against.
 * Nothing here knows a kind: a drag is legal when the target's kind is in the
 * accepted set the constraint expands to, which is what makes a third-party
 * kind wirable the day it is imported.
 */
/** One spelling of a call: where the reference is written, and what may be
 *  written there. */
export interface DispatchSpelling {
  /** Concrete path the reference is written at — an existing slot, the array's
   *  append path when the drag started from the "+" handle, or a row's own
   *  dispatch site. */
  concretePath: string;
  /** Kinds it accepts, canonicalized — what validates a wire, and what a
   *  create-and-link may offer. */
  refs: string[];
}

/**
 * The site a gesture started from: where the picker is drawn, and every way the
 * grammar lets the call be written.
 *
 * **Several spellings, one site**, because a boot target has two and they differ
 * in what they ACCEPT: a bare `!ref` takes a `Telo.Runnable | Telo.Service`,
 * while the entry's `invoke:` takes any `Telo.Executable`. Reading only the
 * first is what made every `Telo.Invocable` in an application unofferable —
 * legal in the manifest, and absent from every affordance, which reads as a
 * module with nothing in it rather than as a missing site. The primary is what
 * an unconstrained choice writes; the rest are reached by what they accept.
 */
export interface WireSite {
  source: GraphNode;
  /** The row or port slot the gesture started from — where the picker is drawn,
   *  and never where the reference lands (a boot target's picker sits on
   *  `targets[0]` and may write `targets[0].invoke`). */
  anchor: string;
  /** Primary first. */
  spellings: DispatchSpelling[];
}

/**
 * The site a source handle designates. Handles are sanitized for the DOM, so
 * the match is on the sanitized form rather than the raw path.
 *
 * **A ROW is a site too**, and it was not: a step's `invoke:` is declared on the
 * step item schema, which sits behind a local `$ref` the reference field map
 * deliberately never descends — so a sequence has no port for it, nothing here
 * matched a step row's handle, and every drag from one was refused. Edges left
 * those rows and no edge could be started from them. The row carries its own
 * dispatch site now, which is also the only address a create-and-link at a step
 * could be written to.
 */
export function siteOfHandle(node: GraphNode, handle: string | null | undefined): WireSite | null {
  if (!handle) return null;
  for (const port of node.ports) {
    // A ROW-OWNED port draws no line of its own — its occupancy is the rows of
    // the array it sits in — so it has no handle and no `+`, and both of its
    // paths belong to a row. Answering for one here is what made a boot target's
    // `+` resolve to the port's bare-reference constraint and lose the entry's
    // other spellings with it.
    if (port.rowOwned) continue;
    for (const slot of port.slots) {
      if (handleId(slot.path) === handle) {
        return {
          source: node,
          anchor: slot.path,
          spellings: [{ concretePath: slot.path, refs: port.refs }],
        };
      }
    }
    if (port.addPath && handleId(port.addPath) === handle) {
      return {
        source: node,
        anchor: port.addPath,
        spellings: [{ concretePath: port.addPath, refs: port.refs }],
      };
    }
  }
  for (const row of node.rows) {
    // Two ways a row is named: its own handle, which a drag leaves from, and its
    // dispatch path, which is what a `+` beside the row reports. Both designate
    // the same site.
    if (!row.dispatch) continue;
    if (handleId(row.path) !== handle && handleId(row.dispatch.path) !== handle) continue;
    return {
      source: node,
      anchor: row.path,
      spellings: [
        { concretePath: row.dispatch.path, refs: row.dispatch.refs },
        ...(row.dispatch.alternatives ?? []).map((alt) => ({
          concretePath: alt.path,
          refs: alt.refs,
        })),
      ],
    };
  }
  return null;
}

/**
 * The spelling that would hold this target — the primary where it accepts it,
 * else the first alternative that does.
 *
 * This is what turns "several spellings" into one write: a reader picks a
 * resource, never a syntax, so the site the reference lands at follows from the
 * kind rather than from a choice they were asked to make.
 */
export function spellingFor(
  site: WireSite,
  target: { kind: string },
  resolver: RefResolver,
): DispatchSpelling | undefined {
  return site.spellings.find((spelling) => accepts(spelling, target, resolver));
}

/** Every kind any spelling of this site accepts — what a create-and-link may
 *  offer, and what a resolvable-constraint check reads. */
export function siteRefs(site: WireSite): string[] {
  return [...new Set(site.spellings.flatMap((spelling) => spelling.refs))];
}

/**
 * May this slot hold that resource?
 *
 * Undecidable is treated as ALLOWED: a constraint the registry cannot resolve
 * (an unresolved import) would otherwise make every slot on the canvas refuse
 * every drop, which reads as the editor being broken rather than as the import
 * being unresolved — and the written reference is still checked by `telo check`,
 * which reports the real reason.
 */
export function accepts(
  slot: { refs: string[] },
  /** Only the kind is read, so a kind about to be CREATED is asked the same
   *  question as one that already exists — the two must land in the same
   *  spelling or a create-and-link would write where a link would not. */
  target: { kind: string; canonicalKind?: string },
  resolver: RefResolver,
): boolean {
  // The projection's own resolution wins: it resolved the kind in the module
  // that WROTE it, which is the only scope a `Self.` spelling means anything in.
  // Resolving it here instead reads a library's `kind: Self.WriteLine` in the
  // entry module's scope, where `Self` is a different module — so every
  // instance an imported library declares of its own kinds was refused by every
  // slot, with no diagnostic, because the two names simply never matched.
  const canonical = target.canonicalKind ?? resolver.resolveKind(target.kind) ?? target.kind;
  for (const ref of slot.refs) {
    const accepted = resolver.acceptedKindsForRef(ref);
    if (!accepted) return true;
    if (accepted.has(canonical) || accepted.has(target.kind)) return true;
  }
  return slot.refs.length === 0;
}

/**
 * The declarations a slot may be pointed at.
 *
 * ONE rule, and three surfaces read it: the drag (which lands on a box), the
 * picked slot's select, and the menu the `+` opens. Two of the three used to
 * answer differently — the menu offered kinds to CREATE and nothing else, so a
 * slot whose only sensible filling was a resource that already exists had no way
 * to say so, and an imported instance had no way at all now that it is not a box
 * to drag onto.
 *
 * `slot` is a single spelling or a whole site: a drag lands on a box and any
 * spelling that takes it will do, while a rail port has only the one.
 *
 * An owned declaration is never offered: an inline or `with:`-scoped resource
 * exists nowhere but its owner's YAML and has no name to reference it by. Nor
 * is the module root, which is not a resource.
 */
export function referenceableTargets(
  slot: { refs: string[] } | WireSite,
  nodes: readonly GraphNode[],
  resolver: RefResolver,
): GraphNode[] {
  const takes = (node: GraphNode): boolean =>
    "spellings" in slot
      ? !!spellingFor(slot, node, resolver)
      : accepts(slot, node, resolver);
  return nodes.filter(
    (node) =>
      !node.root &&
      node.ownership !== "inline" &&
      node.ownership !== "scoped" &&
      takes(node),
  );
}

/** Why a drop was refused, for the reader who just tried it. */
export function refusalReason(slot: { refs: string[] }, target: { kind: string; name: string }): string {
  const kinds = slot.refs.length > 0 ? slot.refs.join(" or ") : "nothing";
  return `${target.name} is a ${target.kind}; this slot takes ${kinds}`;
}

/** The name a reference to this node is WRITTEN with: alias-qualified when it
 *  crosses an import boundary, bare when it does not. */
export function referenceName(target: GraphNode): string {
  return target.external && target.alias ? `${target.alias}.${target.name}` : target.name;
}

/** Whether a node may be wired FROM at all — a published import's files are not
 *  the workspace's, so its slots have nowhere to write. */
export function isWirable(node: GraphNode, graph: ModuleGraph, editable: boolean): boolean {
  return editable && !!graph.nodeById(node.id);
}

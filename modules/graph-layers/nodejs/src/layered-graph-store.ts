import type { InvokeContext } from "@telorun/sdk";
import {
  isGraphStore,
  type Absent,
  type Found,
  type GraphNodeType,
  type GraphNodeValue,
  type GraphRelationshipType,
  type GraphRelationshipValue,
  type GraphStore,
} from "@telorun/graph";

/** This layer states nothing for the key or pair: neither a value nor a removal. */
export type NotStated = { readonly status: "notStated" };

/**
 * The base level of the layered contract: a graph store that is one named
 * layer. Everything `GraphStore` promises holds over the layered view — the
 * store's own statements over those of the layers beneath it — and every value
 * it returns carries the layer it was resolved from as `origin`.
 *
 * It adds what the lifecycle kinds call. As in `GraphStore`, each member
 * answers with a value or an OUTCOME, never a code, and is atomic: it joins the
 * caller's transaction when one is open and otherwise commits on its own.
 *
 * A further level of the contract (a drafted store, a revisioned one) extends
 * this interface and adds its own guard; a member here never changes meaning.
 */
export interface LayeredGraphStore extends GraphStore {
  /** The layer's name: the `origin` of everything this store itself states. */
  readonly layer: string;

  /**
   * Withdraw this layer's own statement for `key` — a stated node or a removal —
   * so whatever lies beneath shows again. Found with the node now resolved,
   * absent when no layer beneath holds one.
   */
  retractNode(
    type: GraphNodeType,
    key: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphNodeValue> | Absent | NotStated>;

  /** As {@link retractNode}, for the relationship joining an ordered pair. */
  retractRelationship(
    type: GraphRelationshipType,
    source: unknown,
    target: unknown,
    ctx?: InvokeContext,
  ): Promise<Found<GraphRelationshipValue> | Absent | NotStated>;
}

export function isLayeredGraphStore(value: unknown): value is LayeredGraphStore {
  const store = value as LayeredGraphStore | undefined;
  return (
    isGraphStore(value) &&
    typeof store?.layer === "string" &&
    typeof store.retractNode === "function" &&
    typeof store.retractRelationship === "function"
  );
}

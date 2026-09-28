import { InvokeError } from "@telorun/sdk";
import type {
  GraphNodeType,
  GraphRelationshipType,
  TraversalDirection,
  TraversalHop,
  TraversalSpec,
} from "./graph-store.js";

/**
 * The creation-time twins of the rules `graph` declares on its kinds. `telo
 * check` reports each from the declarations; these raise the same refusal when
 * the resource is created, for a caller whose check never saw it (a library's
 * internals, or a module reached without `telo check`).
 */

function refuse(code: string, message: string): never {
  throw new InvokeError(code, `${code}: ${message}`);
}

/** `GRAPH_ENDPOINT_NOT_IN_STORE` — a store lists a relationship type whose source
 *  or target node type it does not list. Every backend's store runs this. */
export function assertEndpointsListed(
  describe: string,
  nodes: readonly GraphNodeType[],
  relationships: readonly GraphRelationshipType[],
  nameOf: (type: object) => string,
): void {
  relationships.forEach((relationship, index) => {
    for (const endpoint of ["source", "target"] as const) {
      if (!nodes.includes(relationship[endpoint])) {
        refuse(
          "GRAPH_ENDPOINT_NOT_IN_STORE",
          `${describe} lists relationship type '${nameOf(relationship)}' at ` +
            `'relationships[${index}]', whose ${endpoint} node type ` +
            `'${nameOf(relationship[endpoint])}' it does not list in 'nodes:'. Add the ` +
            `endpoint node type to 'nodes:', or remove the relationship type.`,
        );
      }
    }
  });
}

/** `GRAPH_TYPE_NOT_IN_STORE` for a node type. */
export function assertNodeListed(
  describe: string,
  field: string,
  type: GraphNodeType,
  listed: readonly GraphNodeType[],
  nameOf: (type: object) => string,
): void {
  if (!listed.includes(type)) {
    refuse(
      "GRAPH_TYPE_NOT_IN_STORE",
      `${describe} names node type '${nameOf(type)}' at '${field}', which its store does ` +
        `not list in 'nodes:'.`,
    );
  }
}

/** `GRAPH_TYPE_NOT_IN_STORE` for a relationship type. */
export function assertRelationshipListed(
  describe: string,
  field: string,
  type: GraphRelationshipType,
  listed: readonly GraphRelationshipType[],
  nameOf: (type: object) => string,
): void {
  if (!listed.includes(type)) {
    refuse(
      "GRAPH_TYPE_NOT_IN_STORE",
      `${describe} names relationship type '${nameOf(type)}' at '${field}', which its ` +
        `store does not list in 'relationships:'.`,
    );
  }
}

/** The node type a hop enters, and the one it leaves at. */
function hopEnds(hop: TraversalHop): { enters: GraphNodeType; leaves: GraphNodeType } {
  return hop.direction === "in"
    ? { enters: hop.relationship.target, leaves: hop.relationship.source }
    : { enters: hop.relationship.source, leaves: hop.relationship.target };
}

/**
 * The traversal rules, in the order `telo check` would name them for one hop:
 * `GRAPH_HOP_RANGE_INVALID`, `GRAPH_HOP_REPEAT_MIXED_TYPES`, then
 * `GRAPH_HOPS_DISCONNECTED` over the whole chain.
 */
export function assertTraversable(
  describe: string,
  spec: TraversalSpec,
  nameOf: (type: object) => string,
): void {
  spec.hops.forEach((hop, index) => {
    if (hop.maxHops < hop.minHops) {
      refuse(
        "GRAPH_HOP_RANGE_INVALID",
        `${describe} sets maxHops below minHops at 'hops[${index}]'.`,
      );
    }
    const repeats = hop.direction === "both" || hop.maxHops > 1;
    if (repeats && hop.relationship.source !== hop.relationship.target) {
      refuse(
        "GRAPH_HOP_REPEAT_MIXED_TYPES",
        `${describe} follows relationship type '${nameOf(hop.relationship)}' at ` +
          `'hops[${index}]' with direction '${hop.direction}' up to ${hop.maxHops} time(s), ` +
          `but its source and target are different node types, so it could not chain ` +
          `onto itself. Only a relationship between nodes of one type repeats.`,
      );
    }
  });

  let at: GraphNodeType = spec.from;
  let atName = "'from'";
  spec.hops.forEach((hop, index) => {
    const { enters, leaves } = hopEnds(hop);
    if (enters !== at) {
      refuse(
        "GRAPH_HOPS_DISCONNECTED",
        `${describe}: 'hops[${index}]' follows '${nameOf(hop.relationship)}' ` +
          `${hop.direction === "in" ? "from its target" : "from its source"} ` +
          `'${nameOf(enters)}', but ${atName} ends at '${nameOf(at)}'.`,
      );
    }
    at = leaves;
    atName = `'hops[${index}]'`;
  });
  if (at !== spec.to) {
    refuse(
      "GRAPH_HOPS_DISCONNECTED",
      `${describe}: the last hop ends at '${nameOf(at)}', but 'to' is '${nameOf(spec.to)}'.`,
    );
  }
}

export function isTraversalDirection(value: unknown): value is TraversalDirection {
  return value === "out" || value === "in" || value === "both";
}

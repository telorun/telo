// Browser-safe, framework-agnostic surface: wire types + filtering + SSE client.
// No React, no Node built-ins — importable by the CLI (bun `source` condition),
// the editor webview, and the standalone app alike. The wire types re-export
// from `@telorun/debug-wire` (the shared contract).
export {
  type DebugFrame,
  type DebugEvent,
  type DebugLog,
  type WireRef,
  type WireBlob,
  isLogFrame,
  isEventFrame,
  isWireRef,
  isWireBlob,
  eventSuffix,
} from "./wire.js";
export { type AppEndpoint, endpointHref, endpointLabel } from "./endpoints.js";
export { type EventFilter, matchesFilter, distinctSuffixes } from "./filter.js";
export type { DebugTheme } from "./theme.js";
export { type DebugStreamHandlers, connectDebugStream } from "./sse-client.js";
export { type FoundBlob, collectBlobs, blobDimensions, formatBytes } from "./media.js";
export {
  type GraphState,
  type GraphNode,
  type GraphEdge,
  type NodeStatus,
  type InvokeOutcome,
  type InvokeRecord,
  type Invocation,
  type TraceState,
  type TraceNode,
  type TraceEdge,
  type TraceSubgraph,
  deriveGraph,
  deriveInvocations,
  traceSubgraph,
} from "./graph.js";

// Browser-safe, framework-agnostic surface: wire types + filtering + SSE client.
// No React, no Node built-ins — importable by the CLI (bun `source` condition),
// the editor webview, and the standalone app alike.
export {
  type DebugEvent,
  type WireRef,
  type WireBlob,
  isWireRef,
  isWireBlob,
  eventSuffix,
} from "./wire.js";
export { type EventFilter, matchesFilter, distinctSuffixes } from "./filter.js";
export { type DebugStreamHandlers, connectDebugStream } from "./sse-client.js";
export { type FoundBlob, collectBlobs, blobDimensions, formatBytes } from "./media.js";

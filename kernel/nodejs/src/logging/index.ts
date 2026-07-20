/**
 * Structured logging — the Node.js implementation of `kernel/specs/logging.md`.
 *
 * The record model, severity scale, and `Logger` surface live in `@telorun/sdk`
 * because module authors consume them; everything here is the runtime half —
 * the pipeline, the encodings, the sinks, and the policies that gate emission.
 * The redaction path grammar lives in `@telorun/analyzer` so `telo check` and
 * the runtime share one parser rather than two that can drift.
 */

export { BOOTSTRAP_SINK_ID, createBootstrapWriter } from "./bootstrap-writer.js";
export { decideColor } from "./color-precedence.js";
export type { ColorDecisionInput, ColorSetting } from "./color-precedence.js";
export { ConsoleSink } from "./console-sink.js";
export { DEBUG_WIRE_SINK_ID, DebugWireSink } from "./debug-wire-sink.js";
export type { ConsoleDestination, ConsoleEncoding, ConsoleSinkOptions } from "./console-sink.js";
export { DropRegistry, PIPELINE_SINK_ID } from "./drop-accounting.js";
export type { DropReport } from "./drop-accounting.js";
export { base64Bytes, encodeJson, encodeJsonLine, toJsonProfile } from "./encode-json.js";
export type { BytesEncoder, JsonEncodeOptions } from "./encode-json.js";
export { encodePretty, encodePrettyLine } from "./encode-pretty.js";
export type { PrettyEncodeOptions } from "./encode-pretty.js";
export { FileSink } from "./file-sink.js";
export type { FileEncoding, FileSinkOptions } from "./file-sink.js";
export {
  BLOCK_UNSUPPORTED,
  blockUnsupportedMessage,
  DEFAULT_BUFFER_POLICY,
} from "./log-sink.js";
export type { DropCause, LogSinkInstance, OnFull, SinkBufferPolicy } from "./log-sink.js";
export { LoggingPipeline, ROOT_SCOPE_CONFIG } from "./logging-pipeline.js";
export type { PipelineOptions, ScopeConfig, TraceContextProvider } from "./logging-pipeline.js";
export {
  DEFAULT_ATTRIBUTE_LIMITS,
  normalizeAttributes,
} from "./normalize-attributes.js";
export type { AttributeLimits, NormalizedAttributes, NormalizeOptions } from "./normalize-attributes.js";
export {
  compileRedactionPolicy,
  DEFAULT_CENSOR,
  EMPTY_REDACTION_POLICY,
  redactAttributes,
  redactError,
} from "./redact-attributes.js";
export type { CompiledRedactionPath, RedactionPolicy } from "./redact-attributes.js";
export { RecordBuffer } from "./record-buffer.js";
export { Sampler } from "./sampler.js";
export type { SamplingConfig } from "./sampler.js";
export {
  formatSpanCounter,
  formatSpanId,
  newTraceId,
  normalizeSpanId,
  normalizeTraceId,
  saltSpanId,
} from "./span-id.js";
export { toErrorValue } from "./to-error-value.js";
export {
  formatTraceParent,
  parseTraceParent,
  parseTraceState,
  TRACE_FLAG_RANDOM,
  TRACE_FLAG_SAMPLED,
} from "./trace-parent.js";
export type { TraceContext } from "./trace-parent.js";

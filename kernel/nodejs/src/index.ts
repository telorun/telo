export { ControllerLoader } from "./controller-loader.js";
export { ControllerRegistry } from "./controller-registry.js";
export { EvaluationContext } from "./evaluation-context.js";
export { LocalFileSource } from "./manifest-sources/local-file-source.js";
export {
  LocalManifestCacheSource,
  cachePathForCanonical,
  resolveCacheRoot,
  resolveEntryDir,
  writeManifestCache,
} from "./manifest-sources/local-manifest-cache-source.js";
export { MemorySource } from "./manifest-sources/memory-source.js";
export type { Transport } from "./transports/transport.js";
export { RegistryTransport } from "./transports/registry-transport.js";
export { OciTransport } from "./transports/oci/oci-transport.js";
export { OciClient } from "./transports/oci/oci-client.js";
export { isOciRef, parseOciRef, type ParsedOciRef } from "./transports/oci/oci-ref.js";
export {
  TransportRegistry,
  defaultTransports,
  defaultTransportRegistry,
} from "./transports/transport-registry.js";
export { makeTarGz, readTarGz, type BundleEntry } from "./bundle/tar.js";
export {
  computeFilesIntegrity,
  injectFilesIntegrity,
  type PayloadFile,
} from "./bundle/files-integrity.js";
export type {
  FetchedArtifact,
  PublishBundle,
  PublishResult,
  PublishOptions,
} from "./transports/transport.js";
export { ExecutionContext } from "./execution-context.js";
export { Kernel, type KernelOptions } from "./kernel.js";
export { nodeCelHandlers } from "./cel-handlers.js";
export { ModuleContext } from "./module-context.js";
export { ManifestRegistry as Registry } from "./registry.js";
export { ResourceURI } from "./resource-uri.js";
export type { RuntimeDiagnostic } from "@telorun/sdk";

// Structured logging — the runtime half of kernel/specs/logging.md. The record
// model, severity scale, and `Logger` surface live in `@telorun/sdk`; these are
// the pipeline, the encodings, the sinks, and the policies that gate emission.
export {
  BOOTSTRAP_SINK_ID,
  ConsoleSink,
  DEBUG_WIRE_SINK_ID,
  DebugWireSink,
  DEFAULT_ATTRIBUTE_LIMITS,
  DEFAULT_BUFFER_POLICY,
  DEFAULT_CENSOR,
  DropRegistry,
  FileSink,
  LoggingPipeline,
  PIPELINE_SINK_ID,
  RecordBuffer,
  Sampler,
  base64Bytes,
  blockUnsupportedMessage,
  compileRedactionPolicy,
  createBootstrapWriter,
  decideColor,
  encodeJson,
  encodeJsonLine,
  encodePretty,
  encodePrettyLine,
  formatSpanCounter,
  formatSpanId,
  formatTraceParent,
  normalizeAttributes,
  normalizeSpanId,
  normalizeTraceId,
  parseTraceParent,
  redactAttributes,
  redactError,
  saltSpanId,
  toErrorValue,
  toJsonProfile,
} from "./logging/index.js";
export type {
  AttributeLimits,
  ColorSetting,
  DropCause,
  DropReport,
  LogSinkInstance,
  OnFull,
  RedactionPolicy,
  SamplingConfig,
  ScopeConfig,
  SinkBufferPolicy,
  TraceContext,
} from "./logging/index.js";
export { KernelLogging } from "./logging/kernel-logging.js";
export type { LoggingHost } from "./logging/logging-host.js";

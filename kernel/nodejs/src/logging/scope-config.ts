import type { LogAttributes } from "@telorun/sdk";
import type { RedactionPolicy } from "./redact-attributes.js";
import type { SamplingConfig } from "./sampler.js";

/**
 * Per-module-context logging configuration — `kernel/specs/logging.md` §12.2.
 *
 * Resolved once when the import graph is built and held as plain values: there
 * is no per-record lookup and no walk up the import chain at emit time.
 *
 * This is a **leaf type module** on purpose. `ScopeConfig` is stamped onto the
 * generic `ModuleContext` and read by `internal-context` / `resource-context`,
 * so having those import it from the 400-line `logging-pipeline` would point
 * generic core plumbing at a specific subsystem's implementation. Keeping the
 * type here — depending only on the two policy leaves and the SDK — keeps that
 * dependency pointing at a type, not at the pipeline.
 */
export interface ScopeConfig {
  /** The resolved level for this module context. Also the default a sink's own
   *  `level` falls back to (§12.1). */
  threshold: number;
  redaction: RedactionPolicy;
  sampling?: SamplingConfig;
  /** Values bound to the manifest's `secrets:`, redacted with no configuration
   *  (§14). Cascades down the import graph exactly as the threshold does. */
  secretValues?: ReadonlySet<string>;
  /** Dotted import-alias path of the emitting module context. Absent at root. */
  scope?: string;
  module?: string;
  /** Resource-level attributes merged into every record from this scope. */
  attributes?: LogAttributes;
}

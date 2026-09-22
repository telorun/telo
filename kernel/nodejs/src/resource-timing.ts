/**
 * Per-resource create / init timings, emitted as `Kernel.ResourceCreateCompleted`
 * and `Kernel.ResourceInitializationCompleted`.
 *
 * They are measured only while something listens: the init loop re-attempts
 * deferred resources pass after pass, so an unconditional clock read and an
 * awaited emit per attempt is cost every run pays for a profile almost none take.
 * Whether anyone listens is the event bus's answer, reached through the one
 * `emit` every context — root, scope, import — already shares.
 */
import type { EmitEvent, ResourceManifest } from "@telorun/sdk";

export const RESOURCE_CREATE_COMPLETED = "Kernel.ResourceCreateCompleted";
export const RESOURCE_INITIALIZATION_COMPLETED = "Kernel.ResourceInitializationCompleted";

const listenerQueries = new WeakMap<EmitEvent, (event: string) => boolean>();

/** Attach the event bus's listener query to the `emit` it backs. */
export function withListenerQuery(emit: EmitEvent, hasHandlers: (event: string) => boolean): EmitEvent {
  listenerQueries.set(emit, hasHandlers);
  return emit;
}

/** Whether `event` emitted through `emit` reaches any listener. */
export function isListened(emit: EmitEvent, event: string): boolean {
  return listenerQueries.get(emit)?.(event) === true;
}

/** A clock reading, or undefined when nobody listens for `event`. */
export function startTiming(emit: EmitEvent, event: string): bigint | undefined {
  return isListened(emit, event) ? process.hrtime.bigint() : undefined;
}

/** The timing event's payload. */
export function resourceTiming(
  resource: ResourceManifest,
  id: string,
  startedAt: bigint,
  outcome: string,
): Record<string, unknown> {
  const module = resource.metadata.module;
  return {
    resource: {
      kind: resource.kind,
      name: resource.metadata.name,
      ...(typeof module === "string" ? { module } : {}),
      id,
    },
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    outcome,
    // An import's creation loads and initializes a whole module, whose resources
    // report their own timings; summing both would count that work twice.
    ...(resource.kind === "Telo.Import" ? { aggregate: true } : {}),
  };
}

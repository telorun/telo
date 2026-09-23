/**
 * Per-resource create / init timings, emitted as `Kernel.ResourceCreateCompleted`
 * and `Kernel.ResourceInitializationCompleted`.
 *
 * They are measured only while something listens: the init loop re-attempts
 * deferred resources pass after pass, so an unconditional clock read and an
 * awaited emit per attempt is cost every run pays for a profile almost none take.
 * Whether anyone listens is the event bus's answer, reached through the one
 * `emit` every context — root, scope, import — already shares.
 *
 * Each window also carries the change in memory in use across it
 * (`heapDeltaBytes`).
 */
import type { EmitEvent, ResourceManifest } from "@telorun/sdk";
import { getHeapStatistics } from "v8";

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

/** Where a timed window started: the clock, and the memory in use. */
export interface TimingStart {
  readonly at: bigint;
  readonly memoryBytes: number;
}

/** Heap plus off-heap (`external`, which includes array buffers) memory in use.
 *  Read from the heap statistics rather than `process.memoryUsage()`, which also
 *  reads the resident set size — several times the cost, paid twice per window. */
function memoryInUse(): number {
  const { used_heap_size, external_memory } = getHeapStatistics();
  return used_heap_size + external_memory;
}

/** A start reading, or undefined when nobody listens for `event`. The clock is
 *  read last, so the memory reading stays outside the window it measures. */
export function startTiming(emit: EmitEvent, event: string): TimingStart | undefined {
  if (!isListened(emit, event)) return undefined;
  const memoryBytes = memoryInUse();
  return { at: process.hrtime.bigint(), memoryBytes };
}

/** The timing event's payload. */
export function resourceTiming(
  resource: ResourceManifest,
  id: string,
  started: TimingStart,
  outcome: string,
): Record<string, unknown> {
  const startedAt = started.at;
  const module = resource.metadata.module;
  return {
    resource: {
      kind: resource.kind,
      name: resource.metadata.name,
      ...(typeof module === "string" ? { module } : {}),
      id,
    },
    // Monotonic, so a consumer can nest one resource's window inside another's.
    startedAtMs: Number(startedAt) / 1_000_000,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    // What the window allocated MINUS what the collector freed meanwhile — so a
    // collection inside the window makes it small or negative. A reading, not a
    // retained size: one heap is shared by everything the process runs.
    heapDeltaBytes: memoryInUse() - started.memoryBytes,
    outcome,
    // An import's creation loads and initializes a whole module, whose resources
    // report their own timings; summing both would count that work twice.
    ...(resource.kind === "Telo.Import" ? { aggregate: true } : {}),
  };
}

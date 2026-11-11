import { isCelRecord } from "@telorun/sdk";
import { REDACTED } from "./instance-sensitive-paths.js";

/**
 * The redaction set of one scope run (`kernel/specs/logging.md` §14.5).
 *
 * Filled once, at scope entry, with the text of the opening inputs at every path
 * the holder's input contract marks `x-telo-sensitive` (string leaves beneath
 * included), and layered over the set of the run enclosing the holder, if any —
 * the module context's own set keeps redacting as it does for every record. Never
 * cleared: it is dropped by reference with the run, so an event serialized late
 * still redacts. A value matches by substring at any length, every occurrence.
 *
 * What a run's set covers is decided by ownership and explicit dispatch
 * identity, never by ambient payload: a resource created in the run
 * ({@link bindInstanceRedaction}), a dispatch carrying the run's identity
 * ({@link redactionOfRun}), and a failure that left the run
 * ({@link attachErrorRedaction}).
 */
export class RunRedaction {
  readonly #values: readonly string[];

  constructor(
    values: Iterable<string>,
    readonly enclosing: RunRedaction | undefined,
  ) {
    // Longest first, so a value containing another is replaced whole.
    this.#values = [...new Set([...values].filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  }

  /** The run's own values, without the enclosing runs'. */
  get size(): number {
    return this.#values.length;
  }

  /** `text` with every occurrence of every value of this run and the runs
   *  enclosing it replaced by the censor. */
  scrub(text: string): string {
    let out = text;
    for (let run: RunRedaction | undefined = this; run; run = run.enclosing) {
      for (const value of run.#values) {
        if (out.includes(value)) out = out.split(value).join(REDACTED);
      }
    }
    return out;
  }

  /** `value` with every string scrubbed, copy-on-write through arrays and plain
   *  records; anything else is handed back as it is. */
  scrubValue(value: unknown): unknown {
    return scrubWalk(value, this, []);
  }
}

function scrubWalk(value: unknown, run: RunRedaction, ancestors: readonly object[]): unknown {
  if (typeof value === "string") return run.scrub(value);
  if (typeof value !== "object" || value === null) return value;
  const isArray = Array.isArray(value);
  if ((!isArray && !isCelRecord(value)) || ancestors.includes(value)) return value;
  const within = [...ancestors, value];
  if (isArray) {
    let out: unknown[] | undefined;
    (value as unknown[]).forEach((item, index) => {
      const next = scrubWalk(item, run, within);
      if (next === item) return;
      out ??= [...(value as unknown[])];
      out[index] = next;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = scrubWalk(item, run, within);
    if (next === item) continue;
    out ??= { ...(value as Record<string, unknown>) };
    out[key] = next;
  }
  return out ?? value;
}

/** Every string at or beneath each path of `paths` in `value` — the path grammar
 *  `sensitivePathsOfInstance` answers in (`[]` an array element, `{}` a map value). */
export function textsAtPaths(value: unknown, paths: readonly string[][]): string[] {
  const out: string[] = [];
  const leaves = (node: unknown, seen: readonly object[]): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (typeof node !== "object" || node === null || seen.includes(node)) return;
    const within = [...seen, node];
    for (const child of Array.isArray(node) ? node : Object.values(node)) leaves(child, within);
  };
  const at = (node: unknown, path: readonly string[], index: number): void => {
    if (node === null || node === undefined) return;
    if (index === path.length) {
      leaves(node, []);
      return;
    }
    const segment = path[index]!;
    if (segment === "[]") {
      if (Array.isArray(node)) for (const element of node) at(element, path, index + 1);
      return;
    }
    if (typeof node !== "object" || Array.isArray(node)) return;
    if (segment === "{}") {
      for (const child of Object.values(node)) at(child, path, index + 1);
      return;
    }
    at((node as Record<string, unknown>)[segment], path, index + 1);
  };
  for (const path of paths) at(value, path, 0);
  return out;
}

const byInstance = new WeakMap<object, RunRedaction>();

/** Record that `instance` was created in the run `redaction` belongs to. */
export function bindInstanceRedaction(instance: object, redaction: RunRedaction): void {
  if (!byInstance.has(instance)) byInstance.set(instance, redaction);
}

/** The run `instance` was created in, when it was created in one. */
export function instanceRedactionOf(instance: unknown): RunRedaction | undefined {
  return instance && typeof instance === "object" ? byInstance.get(instance) : undefined;
}

const openers = new WeakSet<object>();

/** Record that `instance` opens a scope from its dispatches, so the trace payload
 *  of each of them — the opening dispatch — is redacted by the run's values,
 *  which are its own sensitive inputs. */
export function markScopeOpener(instance: object): void {
  openers.add(instance);
}

/** Whether `instance` opens a scope from its dispatches. */
export function opensDispatchScope(instance: unknown): boolean {
  return !!instance && typeof instance === "object" && openers.has(instance);
}

const byRun = new WeakMap<object, RunRedaction>();

/** A fresh identity for a scope run, answered by {@link redactionOfRun}. Opaque:
 *  a dispatch the holder issues inside the run carries it, never its values. */
export function scopeRunIdentity(redaction: RunRedaction): object {
  const identity = Object.freeze({});
  byRun.set(identity, redaction);
  return identity;
}

/** The run a dispatch's per-dispatch `scopeRun` identity names. */
export function redactionOfRun(identity: unknown): RunRedaction | undefined {
  return identity && typeof identity === "object" ? byRun.get(identity) : undefined;
}

const byError = new WeakMap<object, RunRedaction>();

/** Record that a failure left the run `redaction` belongs to. The innermost run
 *  is kept: its set already layers over the enclosing ones. */
export function attachErrorRedaction(error: unknown, redaction: RunRedaction): void {
  if (error && typeof error === "object" && !byError.has(error)) byError.set(error, redaction);
}

/** The run a failure, or a failure it wraps (`cause`, at any depth), left. */
export function errorRedactionOf(error: unknown): RunRedaction | undefined {
  const seen = new Set<object>();
  for (let at: unknown = error; at && typeof at === "object" && !seen.has(at); ) {
    seen.add(at);
    const found = byError.get(at);
    if (found) return found;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

/** One scrub over every run that applies, or undefined when none does. */
export function combinedScrub(
  runs: readonly (RunRedaction | undefined)[],
): ((value: unknown) => unknown) | undefined {
  const present = runs.filter((run): run is RunRedaction => run !== undefined);
  if (present.length === 0) return undefined;
  return (value) => present.reduce((out, run) => run.scrubValue(out), value);
}

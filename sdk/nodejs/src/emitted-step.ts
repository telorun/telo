import { celMapFromEntries, isCelMap } from "./cel-value-identity.js";
import { stepPath } from "./durable-run.js";
import { memberIdentity, type IndexKey } from "./index-path.js";

/**
 * What a step a `!for-each` emits into a step list carries in place of `name`.
 * Only the one template expansion writes it; an author never does.
 *
 *  - A NAMED repeat's step files its result under `steps.<repeat>`, a map from
 *    the element's key to `{ result }`.
 *  - An UNNAMED repeat's step is identified by the place its `emit:` is written
 *    (`site`) and the index path of the loops it stands in; its result is
 *    published nowhere.
 */
export type EmittedStepIdentity =
  | { readonly repeat: string; readonly key: IndexKey }
  | { readonly site: string; readonly keys: readonly IndexKey[] };

/** The member an emitted step carries its identity under. */
export const EMITTED_STEP_MEMBER = "__emitted";

/** The identity an emitted step carries, or undefined for an authored one. */
export function emittedStepIdentity(step: unknown): EmittedStepIdentity | undefined {
  if (!step || typeof step !== "object") return undefined;
  const identity = (step as Record<string, unknown>)[EMITTED_STEP_MEMBER];
  if (!identity || typeof identity !== "object") return undefined;
  const value = identity as Record<string, unknown>;
  if (typeof value.repeat === "string" && (typeof value.key === "string" || typeof value.key === "number")) {
    return { repeat: value.repeat, key: value.key };
  }
  if (typeof value.site === "string" && Array.isArray(value.keys)) {
    return { site: value.site, keys: value.keys as IndexKey[] };
  }
  return undefined;
}

/** The text an emitted step is journaled and named under: `runs['a']`,
 *  `steps_0_emit[0]`. */
export function emittedStepSegment(identity: EmittedStepIdentity): string {
  return "repeat" in identity
    ? memberIdentity(identity.repeat, [identity.key])
    : memberIdentity(identity.site, identity.keys);
}

/** One key of an emitted step's index path as a step-path qualifier. */
function qualifier(key: IndexKey): number | { key: string } {
  return typeof key === "number" ? key : { key };
}

/** What a step is called in a message: its `name`, or an emitted step's
 *  identity text. */
export function stepLabel(step: { readonly name?: unknown }): string {
  if (typeof step.name === "string") return step.name;
  const identity = emittedStepIdentity(step);
  return identity ? emittedStepSegment(identity) : "";
}

/** The journal key of a step in the list at `path`: `<path>/<name>`, or for an
 *  emitted step `<path>/<repeat|site>` qualified by its keys
 *  (`steps/runs['nightlyReport']`, `steps/runs[0]`). Undefined for a step
 *  carrying neither. */
export function stepJournalPath(path: string, step: { readonly name?: unknown }): string | undefined {
  if (typeof step.name === "string" && step.name !== "") return stepPath(path, step.name);
  const identity = emittedStepIdentity(step);
  if (!identity) return undefined;
  return "repeat" in identity
    ? stepPath(path, identity.repeat, qualifier(identity.key))
    : stepPath(path, identity.site, ...identity.keys.map(qualifier));
}

/**
 * Publish a step's result: `steps.<name>` for an authored step; for a step a
 * NAMED repeat emitted, the entry of its key in the map `steps.<repeat>` — a
 * plain map for string keys, a CEL map for a list source's int keys. An unnamed
 * repeat's steps publish nothing.
 */
export function fileStepResult(
  steps: Record<string, unknown>,
  step: { readonly name?: unknown },
  result: unknown,
): void {
  const identity = emittedStepIdentity(step);
  if (!identity) {
    steps[step.name as string] = { result };
    return;
  }
  if (!("repeat" in identity)) return;
  const existing = steps[identity.repeat];
  if (typeof identity.key === "string") {
    const map =
      existing && typeof existing === "object" && !isCelMap(existing)
        ? (existing as Record<string, unknown>)
        : (Object.create(null) as Record<string, unknown>);
    map[identity.key] = { result };
    steps[identity.repeat] = map;
    return;
  }
  const flat: unknown[] = [];
  if (isCelMap(existing)) {
    for (const entry of existing.entries.values()) {
      if (entry.key === BigInt(identity.key)) continue;
      flat.push(entry.key, entry.value);
    }
  }
  flat.push(BigInt(identity.key), { result });
  steps[identity.repeat] = celMapFromEntries(flat as never);
}

import type { ResourceDefinition } from "@telorun/sdk";
import { effectiveAuthorSchema, type DefResolver } from "./extends-resolution.js";
import { declaredReach } from "./reference-reach.js";
import { pointerToPath } from "./resource-rule.js";
import { readRefSlot } from "./ref-slot.js";
import { forEachRefSlotNode } from "./validate-ref-slots.js";

/**
 * The strict half of `x-telo-ref`'s `callsCoReferrers: { kind, slot }` —
 * `X_TELO_REF_INVALID_CALLS_CO_REFERRERS`, read by `telo check` at the kind and
 * by the kernel when it registers the definition, so the two refuse the same
 * annotations. `readRefSlot` reads a well-formed value; this says why any other
 * is refused: a `kind` that does not resolve, a `slot` that is no reference slot
 * of that kind, or one whose kinds cannot hold this slot's target.
 *
 * Browser-safe.
 */

export const CO_REFERRER_CALL_CODE = "X_TELO_REF_INVALID_CALLS_CO_REFERRERS";

export interface CoReferrerCallProblem {
  code: typeof CO_REFERRER_CALL_CODE;
  /** Schema path of the `callsCoReferrers` key, under the definition. */
  path: string;
  message: string;
}

/** The canonical `<module>.<Kind>` a definition registers, or its bare name
 *  for one no module declares. */
export function canonicalKindOf(definition: ResourceDefinition): string {
  const module = definition.metadata?.module;
  const name = definition.metadata?.name as string;
  return module ? `${module}.${name}` : name;
}

/**
 * Whether `kind` is `ancestor` or reaches it along `extends` and the role its
 * `capability:` names — the acceptance every reference slot applies, so a
 * child of a co-referrer kind is a co-referrer.
 */
export function kindIsA(kind: string, ancestor: string, resolve: DefResolver): boolean {
  const seen = new Set<string>();
  const queue = [kind];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const definition = resolve(current);
    if (!definition) continue;
    const { extends: parent, capability } = definition as { extends?: unknown; capability?: unknown };
    if (typeof parent === "string") {
      const resolved = resolve(parent, definition);
      queue.push(resolved ? canonicalKindOf(resolved) : parent);
    }
    if (typeof capability === "string" && capability !== current) queue.push(capability);
  }
  return false;
}

/** The kinds a co-referrer kind's slot at `pointer` accepts, read off its
 *  merged author schema, or undefined when no reference slot is there. */
export function coReferrerSlotKinds(
  definition: ResourceDefinition,
  pointer: string,
  resolve: DefResolver,
): string[] | undefined {
  const path = pointerToPath(pointer);
  const reach = declaredReach(effectiveAuthorSchema(definition, resolve));
  return reach.references.find((reference) => reference.path === path)?.kinds;
}

/**
 * Every refusal of `callsCoReferrers` on the slots `ownSchema` declares — a slot
 * is judged once, at the kind writing it. `resolve` maps a canonical kind to its
 * definition. A kind it does not find is a refusal when `complete` (the caller
 * holds every kind, as `telo check` does), and is otherwise returned as
 * `pending`, for a caller registering kinds one at a time to retry once it is
 * loaded.
 */
export function coReferrerCallProblems(
  definition: ResourceDefinition,
  ownSchema: unknown,
  resolve: DefResolver,
  complete: boolean,
): { problems: CoReferrerCallProblem[]; pending: string[] } {
  const problems: CoReferrerCallProblem[] = [];
  const pending: string[] = [];
  const name = `'${definition.metadata?.name as string}'`;
  const refuse = (at: string, slotPath: string, why: string): void => {
    problems.push({
      code: CO_REFERRER_CALL_CODE,
      path: `${at}.callsCoReferrers`,
      message:
        `${name}: x-telo-ref at '${slotPath}' declares 'callsCoReferrers', ${why} It is ` +
        `'{ kind: <Alias>.<Kind>, slot: /<pointer> }': the kind whose declarations this ` +
        `dispatch calls, and the reference slot of that kind naming this slot's target.`,
    });
  };

  forEachRefSlotNode(ownSchema, "schema", (node, slotPath) => {
    const carriers: Array<{ annotation: Record<string, unknown>; at: string }> = [];
    const own = node["x-telo-ref"];
    if (own && typeof own === "object" && !Array.isArray(own)) {
      carriers.push({ annotation: own as Record<string, unknown>, at: `${slotPath}.x-telo-ref` });
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, i) => {
        const annotation = (branch as Record<string, unknown> | null)?.["x-telo-ref"];
        if (annotation && typeof annotation === "object" && !Array.isArray(annotation)) {
          carriers.push({ annotation: annotation as Record<string, unknown>, at: `${slotPath}.${key}[${i}].x-telo-ref` });
        }
      });
    }
    for (const { annotation, at } of carriers) {
      const raw = annotation.callsCoReferrers;
      if (raw === undefined) continue;
      const { kind, slot } = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as {
        kind?: unknown;
        slot?: unknown;
      };
      if (typeof kind !== "string" || kind === "" || typeof slot !== "string" || !/^\/./.test(slot)) {
        refuse(at, slotPath, `whose value ${JSON.stringify(raw)} is not an object with a kind and a slot pointer.`);
        continue;
      }
      const target = resolve(kind, definition);
      if (!target) {
        if (complete) refuse(at, slotPath, `and its kind '${kind}' does not resolve.`);
        else pending.push(kind);
        continue;
      }
      const shown = canonicalKindOf(target);
      const slotKinds = coReferrerSlotKinds(target, slot, resolve);
      if (!slotKinds) {
        refuse(at, slotPath, `and '${shown}' declares no reference slot at '${slot}'.`);
        continue;
      }
      const ownKinds = readRefSlot(node as Record<string, any>)?.kinds ?? [];
      // A kind neither half can resolve is another check's to report.
      const unresolved = [...ownKinds, ...slotKinds].filter((k) => !resolve(k));
      if (unresolved.length > 0) {
        if (!complete) pending.push(...unresolved);
        continue;
      }
      const holds = ownKinds.some((mine) =>
        slotKinds.some((theirs) => kindIsA(mine, theirs, resolve) || kindIsA(theirs, mine, resolve)),
      );
      if (!holds) {
        refuse(
          at,
          slotPath,
          `but the slot of '${shown}' at '${slot}' takes ${slotKinds.join(", ")}, which cannot ` +
            `hold this slot's target (${ownKinds.join(", ")}).`,
        );
      }
    }
  });
  return { problems, pending };
}

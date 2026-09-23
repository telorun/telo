import type { EvaluationContext as IEvaluationContext } from "@telorun/sdk";
import { rootContextOf } from "../module/shared-libraries.js";
import { policyFingerprint, type ControllerPolicy } from "../../runtime-registry.js";

/**
 * Which kinds this kernel has registered, by the file that declared them and the
 * controller policy they were registered under.
 *
 * A kind is registered once per kernel, but a library imported from many places
 * brings the same `Telo.Definition` with every isolated import, and creating each
 * copy re-validates, re-stamps and re-registers what is already there. So an
 * import skips a definition this record already holds. The policy is part of the
 * key because a kind's controller is registered per policy: an import asking for
 * another runtime still registers its own.
 *
 * Scoped like the shared-library registry — a `WeakMap` on the root context — so
 * two kernels in one process never see each other's kinds. An entry lives as
 * long as the definition instance that recorded it: its `init()` inverse
 * forgets it, so a library rebuilt in place registers its edited kinds again
 * rather than being skipped on a key that names no content.
 */
const registries = new WeakMap<object, Set<string>>();

function registeredIn(ctx: IEvaluationContext): Set<string> {
  const root = rootContextOf(ctx) as unknown as object;
  let registered = registries.get(root);
  if (!registered) registries.set(root, (registered = new Set()));
  return registered;
}

function keyOf(
  definition: { metadata?: { name?: unknown; source?: unknown } },
  policy: ControllerPolicy | undefined,
): string | undefined {
  const { name, source } = definition.metadata ?? {};
  if (typeof name !== "string" || typeof source !== "string") return undefined;
  return `${source}\0${name}\0${policyFingerprint(policy)}`;
}

export function recordRegisteredDefinition(
  ctx: IEvaluationContext,
  definition: { metadata?: { name?: unknown; source?: unknown } },
  policy: ControllerPolicy | undefined,
): void {
  const key = keyOf(definition, policy);
  if (key) registeredIn(ctx).add(key);
}

export function isDefinitionRegistered(
  ctx: IEvaluationContext,
  definition: { metadata?: { name?: unknown; source?: unknown } },
  policy: ControllerPolicy | undefined,
): boolean {
  const key = keyOf(definition, policy);
  return key !== undefined && registeredIn(ctx).has(key);
}

export function forgetRegisteredDefinition(
  ctx: IEvaluationContext,
  definition: { metadata?: { name?: unknown; source?: unknown } },
  policy: ControllerPolicy | undefined,
): void {
  const key = keyOf(definition, policy);
  if (key) registeredIn(ctx).delete(key);
}

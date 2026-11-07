import type { EvaluationContext } from "@telorun/sdk";

/**
 * A template instance → the child context its body's `resources:` entries are
 * registered in. The child hangs off the DEFINING module's context, so nothing
 * on the consumer's side leads to it; the co-referrer index reads the body's
 * entries through this record as declarations of the instance's own module.
 *
 * Weak and one-way: an instance yields its body, never the reverse.
 */
const bodies = new WeakMap<object, EvaluationContext>();

export function recordTemplateBody(instance: object, body: EvaluationContext): void {
  bodies.set(instance, body);
}

export function templateBodyOf(instance: unknown): EvaluationContext | undefined {
  return instance && typeof instance === "object" ? bodies.get(instance) : undefined;
}

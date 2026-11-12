import { completedWhenProblems } from "@telorun/analyzer";
import { RuntimeError, type ResourceContext } from "@telorun/sdk";

/**
 * `completedWhen` on a reference slot, refused when a kind or a named shape
 * registers, through the analyzer's reader — `telo check` reports the same
 * problems as `X_TELO_REF_INVALID_COMPLETED_WHEN`, and this is what refuses
 * them in a dependency's schema, which the entry-scoped check never reports.
 */
export function refuseInvalidCompletedWhen(
  document: { kind: string; metadata?: { name?: unknown } },
  ownSchema: unknown,
  ctx: Pick<ResourceContext, "lookupSchema">,
): void {
  const [problem] = completedWhenProblems(
    ownSchema,
    `${document.kind} '${String(document.metadata?.name)}'`,
    "schema",
    (id) => ctx.lookupSchema(id) as Record<string, any> | undefined,
  );
  if (problem) {
    throw new RuntimeError(`ERR_${problem.code}`, `${problem.message} (at '${problem.path}')`);
  }
}

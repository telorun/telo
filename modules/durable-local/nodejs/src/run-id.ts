/**
 * The run id an addressing kind is asking about.
 *
 * Shared by every kind that names a run from outside, because the fallback rule
 * is the interesting part and restating it four times is how four spellings of
 * it appear: a configured `run:` expression wins, and a call that supplies
 * `inputs.run` is what makes ONE addressing resource serve every run rather than
 * one per id — the shape an HTTP route needs, where the id is in the path.
 */
import { InvokeError, type ResourceContext } from "@telorun/sdk";

export function runIdOf(
  ctx: ResourceContext,
  configured: string | undefined,
  input: unknown,
  where: string,
): string {
  const raw =
    configured !== undefined
      ? ctx.expandValue(configured, { inputs: input ?? {} })
      : (input as { run?: unknown } | undefined)?.run;
  if (typeof raw !== "string" || !raw) {
    throw new InvokeError(
      "ERR_DURABLE_RUN_ID_INVALID",
      `${where}: no run id. Set 'run:' on the resource, or pass one as 'inputs.run'.`,
      { value: raw },
    );
  }
  return raw;
}

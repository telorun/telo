/**
 * Resolving the journal an addressing kind reads.
 *
 * Every kind in this module that addresses a run from OUTSIDE — deliver, status,
 * result, cancel — reaches the journal directly rather than through the
 * workflow, and that is deliberate: those operations are what a *second*
 * application performs. A webhook receiver that delivers an approval has the
 * store and nothing else; requiring it to declare the workflow would make it
 * depend on the body it is waking, and on every resource that body reaches.
 */
import type { ResourceContext } from "@telorun/sdk";
import { isDurableJournal, type DurableJournal } from "./journal.js";

export function journalOf(
  ctx: ResourceContext,
  ref: unknown,
  where: string,
): DurableJournal {
  return ctx.resolveRef(
    ref,
    isDurableJournal,
    () => `${where}: 'journal'`,
    "DurableLocal.Journal",
  ) as unknown as DurableJournal;
}

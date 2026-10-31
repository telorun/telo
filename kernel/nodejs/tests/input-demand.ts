import type { ApplicationUsageRequirements } from "@telorun/analyzer";
import type { InputDemand } from "../src/application-env.js";

/** A demand requiring every input nothing supplies, as a reading of the
 *  environment alone is tested under; `usage` is what `--help` reports. */
export function demandingEvery(
  usage: ApplicationUsageRequirements = { inputs: [], dimensions: [], needs: [] },
): InputDemand {
  return { required: () => true, usage: () => usage };
}

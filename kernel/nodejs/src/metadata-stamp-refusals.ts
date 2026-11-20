/**
 * The kernel's refusal of a loader stamp an author wrote in `metadata`
 * (`ERR_METADATA_RESERVED_FIELD`) on a declaration the kernel makes itself —
 * one a controller registers inline, a template body entry — which no load may
 * have analysed. At load the analyzer's load refusal rule refuses the stamps the
 * loader and the analysis found.
 */
import { metadataStampMessage, writtenNestedStamps } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";

/** Refuses each stamp written on `declaration`, a declaration the kernel is
 *  about to make, naming it after `describe`. */
export function refuseWrittenStamps(declaration: unknown, describe: string): void {
  const fields = writtenNestedStamps(declaration);
  if (fields.length === 0) return;
  throw new RuntimeError(
    "ERR_METADATA_RESERVED_FIELD",
    fields
      .map((field) => `${describe}: ${metadataStampMessage(declaration as { kind?: unknown; metadata?: unknown }, field)}`)
      .join("\n"),
  );
}

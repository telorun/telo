/**
 * How this backend lays a recorded value into its journal records —
 * `kernel/specs/durable-execution.md` §5.2 and §6.1.
 *
 * The codec itself — the version, writing a value down and the legacy /
 * unknown-version reading rules — is the SDK's (`recorded-value.ts`), since the
 * spec makes it normative for every backend. What is this backend's is WHERE the
 * version sits: beside the value on each entry (`v`) and on a run record
 * (`inputsCodecVersion`, `resultCodecVersion`). A journal keeps the version and
 * the value together and never looks inside either, so a third-party store cannot
 * break a codec it does not implement.
 */
import { readRecordedValue, RECORDED_VALUE_CODEC_VERSION } from "@telorun/sdk";
import type { JournalEntry, RunRecord } from "./journal.js";

/** One entry, with its value already written down by `writeRecordedValue`. */
export function recordEntry(
  entry: Omit<JournalEntry, "v" | "value">,
  frame: string | undefined,
): JournalEntry {
  return {
    ...entry,
    v: RECORDED_VALUE_CODEC_VERSION,
    // ABSENCE BELONGS TO THE ENTRY. A step whose target returned nothing is
    // journaled all the same — the entry is what says it completed — and the
    // frame refuses a bare `undefined` by design, since it is not a CEL value
    // and giving it a form would stop the codec being one-to-one.
    ...(frame === undefined ? {} : { value: frame }),
  };
}

/** The inputs a scheduled run was recorded with, read back as the values they
 *  were. */
export function recordedRunInputs(record: RunRecord): { value?: unknown } {
  return readRecordedValue(record.run, "inputs", record.inputsCodecVersion, record.inputs);
}

/** A finished run's result, read back as the values it held. */
export function recordedRunResult(record: RunRecord): { value?: unknown } {
  return readRecordedValue(record.run, "result", record.resultCodecVersion, record.result);
}

/** The value a recorded entry holds, ready to hand to a replay. */
export function recordedValue(run: string, entry: JournalEntry): { value?: unknown } {
  return readRecordedValue(run, entry.path, entry.v, entry.value);
}

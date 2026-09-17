/**
 * **How a durable run's recorded value is written down and read back** —
 * `kernel/specs/durable-execution.md` §5.2: a typed frame (§6.1) under a codec
 * version, with the legacy and unknown-version rules the spec makes normative
 * for every backend.
 *
 * In the SDK, beside the typed frame, rather than in one backend: the version
 * names the frame's own format, so a change to the frame and the version it is
 * recorded under move together, and every backend reads a value by the same
 * rules. Where a backend keeps the version beside the value is its own; a journal
 * keeps the two together and looks inside neither.
 */
import { assertJournalable } from "./durable-run.js";
import { InvokeError } from "./invoke-error.js";
import { decodeTypedFrame } from "./typed-frame.js";

/**
 * The codec every recorded value is written under. Bumped only for a change an
 * older reader would MISREAD; a new optional field it can ignore is not one.
 */
export const RECORDED_VALUE_CODEC_VERSION = 1;

/**
 * Write a value down for the record — the one path every record site takes, so
 * none of them can disagree about what a value records as.
 *
 * Absent members are dropped first ({@link withoutAbsentMembers}), then the value
 * is refused if it is outside the CEL value domain, at `where.path`; the frame
 * that decided it is what gets recorded, so a value is encoded once. `undefined`
 * when there is no value to record.
 */
export function writeRecordedValue(
  value: unknown,
  where: { run: string; path: string },
): string | undefined {
  return assertJournalable(withoutAbsentMembers(value), where);
}

/**
 * A value as it is recorded: every plain-object member holding no value is left
 * out.
 *
 * `{ a: undefined, b: 1 }` is an ordinary JavaScript result, and a steps map holds
 * `{ result: undefined }` for a step that produced nothing — while the frame
 * refuses `undefined` anywhere, since it is not a CEL value. Such a member is
 * ABSENT, the reading an entry with no value already has, so it is dropped rather
 * than refused, which is also how plain JSON recorded it before the frame. Only
 * plain containers are walked; any other value is the frame's to judge, and an
 * `undefined` array element is still refused.
 */
export function withoutAbsentMembers(value: unknown): unknown {
  return withoutAbsent(value, new Set());
}

/** A container already being copied is returned as it is, so a cycle reaches
 *  the frame intact and is refused there rather than recursing here forever. */
function withoutAbsent(value: unknown, ancestors: Set<object>): unknown {
  if (!value || typeof value !== "object" || ancestors.has(value)) return value;
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  // Anything but a plain list or a plain object — including a list carrying a
  // property beside its items — is left for the frame to judge, untouched.
  if (isArray) {
    if (proto !== Array.prototype || Object.keys(value).length !== (value as unknown[]).length) {
      return value;
    }
  } else if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  ancestors.add(value);
  let out: unknown;
  if (isArray) {
    out = (value as unknown[]).map((item) => withoutAbsent(item, ancestors));
  } else {
    const copy: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) copy[key] = withoutAbsent(member, ancestors);
    }
    out = copy;
  }
  ancestors.delete(value);
  return out;
}

/**
 * The value recorded at `path` of run `run`, ready to hand to a replay.
 *
 * Returns the value under a `value` key rather than as itself, so that a step
 * that produced NOTHING stays distinguishable from one that produced `null` —
 * the difference is whether the key is there at all.
 *
 * - **No version** — written before this codec existed, and read as its store
 *   read it then (plain JSON, plus the `{"$bigint": …}` tag the SQL journals
 *   wrote). Read, never refused: refusing one would strand every run parked
 *   before the codec, which is the opposite of what a journal is for.
 * - **This version** — the frame, decoded. A frame that does not decode is
 *   `ERR_DURABLE_JOURNAL_CORRUPT`, naming the run and the path.
 * - **Any other version** — REFUSED with `ERR_DURABLE_ENTRY_UNDECODABLE`, never
 *   read for the parts that look familiar: a later codec may mean something else
 *   by the same bytes.
 */
export function readRecordedValue(
  run: string,
  path: string,
  version: number | undefined,
  written: unknown,
): { value?: unknown } {
  if (version === undefined) {
    return written === undefined ? {} : { value: written };
  }
  if (version !== RECORDED_VALUE_CODEC_VERSION) {
    throw new InvokeError(
      "ERR_DURABLE_ENTRY_UNDECODABLE",
      `Run '${run}': the value recorded at '${path}' was written by codec version ${version}, and ` +
        `this runtime reads version ${RECORDED_VALUE_CODEC_VERSION}. It is refused rather than read ` +
        `for the parts that look familiar: a later codec may mean something else by the same bytes, ` +
        `and replaying against a misread value is the corruption durability exists to prevent. ` +
        `Continue this run on a runtime new enough to read its journal.`,
      { run, path, version, reads: RECORDED_VALUE_CODEC_VERSION },
    );
  }
  if (written === undefined) return {};
  const corrupt = (why: string, cause?: unknown): InvokeError =>
    new InvokeError(
      "ERR_DURABLE_JOURNAL_CORRUPT",
      `Run '${run}': the value recorded at '${path}' declares codec version ${version}, but ${why}. ` +
        `Something outside this journal has rewritten its records.`,
      { run, path },
      cause === undefined ? undefined : { cause },
    );
  if (typeof written !== "string") throw corrupt("it is not the frame text that codec writes");
  try {
    return { value: decodeTypedFrame(written) };
  } catch (error) {
    throw corrupt(`its frame does not decode (${error instanceof Error ? error.message : String(error)})`, error);
  }
}

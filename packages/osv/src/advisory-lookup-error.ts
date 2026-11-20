export const ADVISORY_LOOKUP_FAILED = "ADVISORY_LOOKUP_FAILED";

/** The advisory database gave no usable answer; no component was judged. */
export class AdvisoryLookupError extends Error {
  readonly code = ADVISORY_LOOKUP_FAILED;

  constructor(
    /** The URL of the request that failed. */
    readonly endpoint: string,
    /** How many attempts were made at it. */
    readonly attempts: number,
    /** What the last attempt failed with. */
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      attempts > 1
        ? `${endpoint} gave no answer after ${attempts} attempts: ${detail}. No component was judged.`
        : `${endpoint} could not be answered: ${detail}. No component was judged.`,
      options,
    );
    this.name = "AdvisoryLookupError";
  }
}

/** The caller's signal aborted the lookup; not an advisory-database failure. */
export class LookupCancelledError extends Error {
  constructor(readonly reason?: unknown) {
    super("the advisory lookup was cancelled");
    this.name = "LookupCancelledError";
  }
}

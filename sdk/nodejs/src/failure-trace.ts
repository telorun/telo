/**
 * The path a failure took through the manifest — `kernel/specs/invocation-contract.md`
 * §5.5. A failure carries FRAMES (resources and manifest positions), added on the
 * failure path only, at each exit the failure leaves. Nothing here is recorded on a
 * dispatch that succeeds.
 *
 * Frames ride the error under symbol keys: non-enumerable, so they reach neither JSON
 * nor `toSequenceError`'s `error` (a catch context never reads `error.frames`), and a
 * symbol so no thrown value's own member can be mistaken for them.
 */

/** One resource a failure passed through. `position` is 1-based and given only for a
 *  declaration the load read from a file (the rule a failure's `location` follows). */
export interface FailureFrame {
  readonly kind: string;
  readonly name: string;
  /** The file the frame's position is in — the declaring module's source. */
  readonly module?: string;
  /** RFC 6901 pointer into the resource's declaration. */
  readonly pointer?: string;
  readonly position?: { readonly line: number; readonly column: number };
}

/** Frames beyond this many are cut, the innermost kept. */
export const FAILURE_FRAME_LIMIT = 64;

const FRAMES = Symbol.for("telo.failure.frames");
const DROPPED = Symbol.for("telo.failure.droppedFrames");
const RAISED_AT = Symbol.for("telo.failure.raisedAt");

function holder(err: unknown): (object & Record<symbol, unknown>) | undefined {
  return typeof err === "object" && err !== null && Object.isExtensible(err)
    ? (err as object & Record<symbol, unknown>)
    : undefined;
}

function define(target: object, key: symbol, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true });
}

/** The frames `err` carries, innermost first. */
export function failureFramesOf(err: unknown): readonly FailureFrame[] {
  if (typeof err !== "object" || err === null) return [];
  return ((err as Record<symbol, unknown>)[FRAMES] as FailureFrame[] | undefined) ?? [];
}

/** How many outer frames the bound cut from `err`'s trace. */
export function droppedFramesOf(err: unknown): number {
  if (typeof err !== "object" || err === null) return 0;
  return ((err as Record<symbol, unknown>)[DROPPED] as number | undefined) ?? 0;
}

/**
 * Add the next, outer frame to `err`'s trace. `frame` is built only when it is kept,
 * so a trace past the bound costs no further lookups. A value that cannot carry
 * members (a primitive, a frozen object) carries no trace.
 */
export function appendFailureFrame(err: unknown, frame: () => FailureFrame): void {
  const target = holder(err);
  if (!target) return;
  const frames = (target[FRAMES] as FailureFrame[] | undefined) ?? [];
  if (frames.length >= FAILURE_FRAME_LIMIT) {
    define(target, DROPPED, ((target[DROPPED] as number | undefined) ?? 0) + 1);
    return;
  }
  frames.push(frame());
  define(target, FRAMES, frames);
}

/** Set a trace wholesale — what a carrier restores, and what a wrapper takes from the
 *  value it wraps. */
export function setFailureFrames(err: unknown, frames: readonly FailureFrame[], dropped = 0): void {
  const target = holder(err);
  if (!target) return;
  const cut = dropped + Math.max(0, frames.length - FAILURE_FRAME_LIMIT);
  define(target, FRAMES, frames.slice(0, FAILURE_FRAME_LIMIT));
  if (cut > 0 || target[DROPPED] !== undefined) define(target, DROPPED, cut);
}

/** Give `to` the trace of `from` (a copy: the two go on to grow apart). */
export function carryFailureFrames(from: unknown, to: unknown): void {
  const frames = failureFramesOf(from);
  if (frames.length > 0) setFailureFrames(to, frames, droppedFramesOf(from));
}

/** Move the trace of `from` onto `to`: a wrapper takes the trace, the wrapped value keeps none. */
export function moveFailureFrames(from: unknown, to: unknown): void {
  carryFailureFrames(from, to);
  if (failureFramesOf(from).length > 0) setFailureFrames(from, []);
}

/**
 * Say that `err` was raised at `pointer` in the declaration of the resource whose
 * body raised it (a `throw` step's place). The dispatch exit that starts the trace
 * uses it as the pointer of the target's own frame; first statement wins.
 */
export function attachRaisedAt(err: unknown, pointer: string): void {
  const target = holder(err);
  if (!target || target[RAISED_AT] !== undefined) return;
  define(target, RAISED_AT, pointer);
}

/** The pointer {@link attachRaisedAt} recorded, if any. */
export function raisedAtOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Record<symbol, unknown>)[RAISED_AT] as string | undefined;
}

/**
 * One line of a trace: `at <kind>.<name>#<pointer> (<file>:<line>:<column>)`. An
 * empty or absent pointer drops `#<pointer>`; an absent position drops the
 * parenthesised part. `file` is the caller's rendering of the frame's module.
 */
export function failureFrameLine(frame: FailureFrame, file: string | undefined): string {
  const pointer = frame.pointer ? `#${frame.pointer}` : "";
  const where = frame.position
    ? ` (${file ?? frame.module ?? ""}:${frame.position.line}:${frame.position.column})`
    : "";
  return `at ${frame.kind}.${frame.name}${pointer}${where}`;
}

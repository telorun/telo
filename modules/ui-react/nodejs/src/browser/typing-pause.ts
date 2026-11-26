/** How long typing pauses before what was typed is applied: a filter bar under
 *  `apply: typing`, a form's settled record, a picker's search. */
export const TYPING_PAUSE = 300;

/** How a value changed: a choice is whole when it is made, typed text is not
 *  until it is committed or typing pauses. */
export type ChangeKind = "choice" | "typed";

/**
 * The settle rule for entered values, stated once: a choice or a commit
 * (Enter, leaving the field, release) settles at once, typed text after `pause`
 * milliseconds without another change. Each typed change starts the pause again.
 */
export class Settling {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly settled: () => void,
    private readonly pause: number = TYPING_PAUSE,
  ) {}

  /** Whether typed text waits for its pause. */
  get waiting(): boolean {
    return this.timer !== undefined;
  }

  change(kind: ChangeKind): void {
    if (kind === "choice") return this.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.settled();
    }, this.pause);
  }

  /** Settle now, whatever waits: a commit. */
  now(): void {
    this.cancel();
    this.settled();
  }

  /** Drop what waits, settling nothing. */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

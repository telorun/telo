/** What a check found wrong: which rule, about what, and why. */
export interface Problem {
  check: ProblemCheck;
  subject: string;
  message: string;
}

/** The closed set of what a check reports, each named for what is wrong. */
export type ProblemCheck =
  | "part-unstyled"
  | "unstyled-stale"
  | "property-reserved"
  | "token-default-missing"
  | "token-unread"
  | "stylesheet-unparseable"
  | "vector-failed"
  | "scene-failed"
  | "controls-load-failed";

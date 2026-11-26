import type { RunnerTerms } from "./types";

export interface TermsGateInput {
  /** The session's phase and the terms it waits on. */
  session: { phase: string; terms: RunnerTerms | null; runnerId: string } | null;
  activeRunnerId: string | null;
  /** The runner whose terms the user last declined, until they act again. */
  declinedRunnerId: string | null;
}

/**
 * The terms to put before the user, or none: only the active runner's own
 * session asks, and a runner whose terms were declined is not asked again
 * until the user acts (Run, or selecting it again, which is a new session).
 */
export function termsGateToShow({ session, activeRunnerId, declinedRunnerId }: TermsGateInput): RunnerTerms | null {
  if (!session || session.phase !== "terms" || !session.terms) return null;
  if (session.runnerId !== activeRunnerId) return null;
  if (session.runnerId === declinedRunnerId) return null;
  return session.terms;
}

import { RuntimeError, type RuntimeDiagnostic, type RuntimeErrorCode } from "@telorun/sdk";

/**
 * One root Application input no channel supplied a value for — the unit a host
 * is asked about and a missing-values refusal names. Normative:
 * `kernel/specs/application-arguments.md` §4.1.
 */
export interface UnresolvedApplicationInput {
  /** The declaration identity — `variables.googleClientId`, `secrets.token`,
   *  `ports.http`, `needs Orders.databaseAccess.url`. Stable across loads, so a
   *  host may key a session's answers on it. */
  readonly id: string;
  readonly block: "variables" | "secrets" | "ports" | "needs";
  /** The declared name; for a need field, `<need path>.<field>`. */
  readonly name: string;
  /** The environment variable the entry binds. */
  readonly env?: string;
  /** How the command line spells the entry's binding (`--client-id`, `<name>`). */
  readonly arg?: string;
  /** A secret or a sensitive need field: read without echo, never quoted. */
  readonly sensitive: boolean;
  /** What the value is, as `--help` names it (`string`, `tcp port`, `Telo.Url`). */
  readonly type: string;
  /** The schema an answer is validated against once decoded. */
  readonly schema: Record<string, unknown>;
  readonly title?: string;
  readonly description?: string;
  /** Why the last answer given for this entry was refused — the kernel's own
   *  sentence, never quoting a sensitive value. Absent on a first ask. */
  readonly refusal?: string;
}

/**
 * Asked by the kernel for every input still missing once the four channels are
 * read. Answers are text, keyed by {@link UnresolvedApplicationInput.id}, decoded
 * exactly as an `env:` value is. Resolving `undefined` — or leaving an asked
 * entry unanswered — declines, and the load fails with the missing-values
 * refusal. A rejection propagates as the load's own failure.
 */
export type ApplicationInputResolver = (
  unresolved: readonly UnresolvedApplicationInput[],
) => Promise<ReadonlyMap<string, string> | undefined>;

/** A load refused because inputs have no value — and only for that reason — carrying
 *  the entries a host could ask for. Its code is the one the refusal always had. */
export class UnresolvedInputsError extends RuntimeError {
  constructor(
    code: RuntimeErrorCode,
    message: string,
    readonly unresolved: readonly UnresolvedApplicationInput[],
    diagnostics?: RuntimeDiagnostic[],
  ) {
    super(code, message, diagnostics);
  }
}

/** The missing inputs a refusal names, when it is a missing-values refusal. */
export function unresolvedInputsOf(error: unknown): readonly UnresolvedApplicationInput[] | undefined {
  return error instanceof UnresolvedInputsError ? error.unresolved : undefined;
}

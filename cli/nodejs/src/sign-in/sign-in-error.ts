/** The codes a sign-in refuses with. */
export type SignInErrorCode =
  | "ERR_RUNNER_IDENTITY_MISMATCH"
  | "ERR_SIGN_IN_FAILED"
  | "ERR_SIGN_IN_REVOKE_FAILED";

/** A login, logout or store refusal: its code (absent for one with no code of its
 *  own, such as an unreachable issuer), its message and lines to print beneath it. */
export class SignInError extends Error {
  constructor(
    readonly code: SignInErrorCode | undefined,
    message: string,
    readonly hints: readonly string[] = [],
  ) {
    super(message);
  }
}

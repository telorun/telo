import { SignInError } from "../sign-in/sign-in-error.js";

/** A share command's refusal: printed as `error <code>: <message>` (just `error: <message>`
 *  when it has no code of its own) and ended with exit status 1. */
export class ShareRefusal extends Error {
  constructor(
    readonly refusalCode: string | undefined,
    message: string,
    /** Further lines printed beneath it, indented. */
    readonly hints: readonly string[] = [],
  ) {
    super(message);
  }

  /** The lines the refusal prints. */
  lines(label: string): string[] {
    const head = this.refusalCode ? `${label} ${this.refusalCode}: ${this.message}` : `${label}: ${this.message}`;
    return [head, ...this.hints.map((hint) => `  ${hint}`)];
  }
}

/** A failed sign-in, as the refusal that ends a command which offered it. */
export function refusalOfSignIn(error: SignInError): ShareRefusal {
  return new ShareRefusal(error.code, error.message, error.hints);
}

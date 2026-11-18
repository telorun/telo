import { outErrLine, output } from "../output.js";
import type { SignInAccount } from "./credentials-file.js";
import { SignInError } from "./sign-in-error.js";
import type { RunnerSignIn, SignInStatus } from "./runner-sign-in.js";

/** How a person is told who is signed in: their username, else the account's subject. */
export function accountLabel(account: SignInAccount): string {
  return account.username ?? account.sub;
}

/** The lines a refusal or warning prints: `<label> <code>: <message>` (just
 *  `<label>: <message>` without a code of its own), then its hints indented. */
export function signInErrorLines(label: string, code: string | undefined, message: string, hints: readonly string[] = []): string[] {
  return [code ? `${label} ${code}: ${message}` : `${label}: ${message}`, ...hints.map((hint) => `  ${hint}`)];
}

/** Runs a login at the terminal: the URL to open or the code to enter is printed
 *  on stderr (opened or not), Ctrl-C cancels it, and the revocation warning of a
 *  sign-in it replaced is printed too. Throws a {@link SignInError}: the engine's,
 *  or `ERR_SIGN_IN_FAILED` for any other way the login did not complete. */
export async function signInAtTerminal(
  signIn: RunnerSignIn,
  options: { runnerUrl: string; deviceCode?: boolean },
): Promise<SignInStatus> {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort(new SignInError("ERR_SIGN_IN_FAILED", "sign-in cancelled"));
  process.once("SIGINT", onInterrupt);
  try {
    const status = await signIn.login({
      runnerUrl: options.runnerUrl,
      ...(options.deviceCode ? { deviceCode: true } : {}),
      signal: controller.signal,
      onEvent: (event) => {
        switch (event.type) {
          case "browser":
            outErrLine(`Opening your browser to sign in to ${signIn.issuer}. If it does not open, visit:`);
            outErrLine(`  ${event.url}`);
            return;
          case "browser-failed":
            outErrLine(`Could not open a browser (${event.reason}); signing in with a code instead.`);
            return;
          case "device-code":
            outErrLine(`To sign in to ${signIn.issuer}, open ${event.verificationUri} and enter the code ${event.userCode}`);
            if (event.verificationUriComplete !== undefined) outErrLine(`  or open ${event.verificationUriComplete}`);
            outErrLine(`  the code expires at ${event.expiresAt.toISOString()}`);
            return;
        }
      },
    });
    outErrLine(`Signed in to ${status.issuer} as ${accountLabel(status.account!)}`);
    if (status.problem) {
      for (const line of signInErrorLines(output().stderr.warn("warning"), status.problem.code ?? undefined, status.problem.message)) outErrLine(line);
    }
    return status;
  } catch (error) {
    if (error instanceof SignInError) {
      throw error.code === undefined ? new SignInError("ERR_SIGN_IN_FAILED", error.message, error.hints) : error;
    }
    if (controller.signal.aborted && controller.signal.reason instanceof SignInError) throw controller.signal.reason;
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

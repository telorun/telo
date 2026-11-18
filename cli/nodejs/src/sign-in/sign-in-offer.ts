import type { RunnerCredentialRequest } from "@telorun/share-tunnel";

import { InputInterrupted, processInterrupts, readAnswerLine, type PromptInput, type PromptInterrupts } from "../application-input-prompt.js";
import { output, type Output } from "../output.js";
import { personIsAtTerminal, type TerminalStreams } from "../person-at-terminal.js";
import type { RunnerSignIn, SignInCredentialAnswer, SignInCredentialProvider } from "./runner-sign-in.js";
import { signInAtTerminal } from "./sign-in-session.js";

/** Asks the person at the terminal whether to sign in now. */
export interface SignInOffer {
  /** `message` is why the stored sign-in does not do, when it is more than absent. */
  accept(message: string | undefined): Promise<boolean>;
}

/** The offer a command makes, or `undefined` when nobody is at the terminal
 *  (stdin and stderr are not both TTYs, or `--no-input`): then nothing is asked. */
export function terminalSignInOffer(
  streams: TerminalStreams & { stdin: PromptInput },
  out: Output = output(),
  interrupts: PromptInterrupts = processInterrupts,
): SignInOffer | undefined {
  if (!personIsAtTerminal(streams)) return undefined;
  return {
    async accept(message) {
      if (message !== undefined) out.errLine(message);
      out.errPrompt("Sign in to Telo now? [Y/n] ");
      let answer: string | null;
      try {
        answer = await readAnswerLine(streams.stdin, false, interrupts);
      } catch (error) {
        if (error instanceof InputInterrupted) return false;
        throw error;
      }
      if (answer === null) {
        out.errLine();
        return false;
      }
      return /^\s*(y(es)?)?\s*$/i.test(answer);
    },
  };
}

/**
 * `credentials`, except that a sign-in-required answer is first offered a login:
 * accepted, it runs the login `telo auth login --runner <runner>` runs and asks
 * again, so the command carries on as signed in. Declined, or with no `offer`, the
 * answer stands. Rejects with a {@link SignInError} when the login fails.
 * For requests made before the application starts: once it runs, stdin is its own.
 */
export function offeringSignIn(
  credentials: SignInCredentialProvider,
  signIn: RunnerSignIn,
  offer: SignInOffer | undefined,
): SignInCredentialProvider {
  if (offer === undefined) return credentials;
  let declined = false;
  return {
    async credential(request: RunnerCredentialRequest): Promise<SignInCredentialAnswer> {
      const answer = await credentials.credential(request);
      if (answer.outcome !== "sign-in-required" || declined) return answer;
      if (!(await offer.accept(answer.message))) {
        declined = true;
        return answer;
      }
      await signInAtTerminal(signIn, { runnerUrl: request.runnerUrl });
      return credentials.credential(request);
    },
  };
}

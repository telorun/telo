import type { startShareTunnel } from "@telorun/share-tunnel";

import { sameResource } from "../sign-in/runner-identity.js";
import { RunnerSignIn, type SignInCredentialProvider } from "../sign-in/runner-sign-in.js";
import { resolveRunnerUrl } from "./share-runner-url.js";

export type StartShareTunnel = typeof startShareTunnel;

/**
 * What the CLI's commands are handed rather than choose: the composition root
 * (`cli.ts`) is the one place the runner credential provider is picked, and the
 * run and shares commands only ever ask it.
 */
export interface CliServices {
  /** The sign-in the `telo auth` commands and the inline offer drive. */
  signIn: RunnerSignIn;
  /** Where a runner credential comes from: the sign-in, unless a test replaces it. */
  credentials: SignInCredentialProvider;
  /** Loads what opens a share's tunnel, only once a share is taken, so a run
   *  without `--share` loads no WebSocket stack; replaced in tests. */
  loadTunnel: () => Promise<StartShareTunnel>;
}

/** What a user runs to sign in to a runner: `telo auth login`, naming the runner
 *  only when it is not the one login would resolve to in `env`. */
export function signInCommand(runnerUrl: string, env: NodeJS.ProcessEnv): string {
  return sameResource(runnerUrl, resolveRunnerUrl(undefined, env)) ? "telo auth login" : `telo auth login --runner ${runnerUrl}`;
}

export function defaultCliServices(env: NodeJS.ProcessEnv = process.env): CliServices {
  const signIn = new RunnerSignIn({ env, signInCommand: (runnerUrl) => signInCommand(runnerUrl, env) });
  return {
    signIn,
    credentials: signIn,
    loadTunnel: async () => (await import("@telorun/share-tunnel")).startShareTunnel,
  };
}

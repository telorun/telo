import { invoke } from "@tauri-apps/api/core";

import { IdentityProviderUnavailableError, type RunnerTokenAnswer, type RunnerTokenHolder } from "./runner-token";

/** What the shell's `runner_token` command answers. */
type ShellRunnerToken =
  | { status: "token"; accessToken: string; expiresIn: number }
  | { status: "proofRequired"; tokenEndpoint: string; nonce?: string | null }
  | { status: "reauthorizing"; tokenEndpoint: string; nonce?: string | null };

/**
 * The desktop build's runner tokens come from the shell, which holds the
 * sign-in: `runner_token { resource, proof }`. The shell refreshes the
 * runner's own grant with the page's proof — or, with no grant for that
 * runner, authorizes it once in the system browser and redeems the code with
 * the proof — keeps every refresh token in the OS credential store, and
 * answers the access token only. A runner grant the identity provider refuses
 * is deleted and answered `reauthorizing`.
 */
export function desktopRunnerTokenHolder(): RunnerTokenHolder {
  return {
    async exchange(resource, proof): Promise<RunnerTokenAnswer> {
      let answer: ShellRunnerToken;
      try {
        answer = await invoke<ShellRunnerToken>("runner_token", { resource, proof });
      } catch (err) {
        throw shellError(err);
      }
      if (answer.status === "token") {
        return { kind: "token", accessToken: answer.accessToken, expiresIn: answer.expiresIn };
      }
      return {
        kind: answer.status === "reauthorizing" ? "reauthorizing" : "proof",
        tokenEndpoint: answer.tokenEndpoint,
        ...(answer.nonce ? { nonce: answer.nonce } : {}),
      };
    },
  };
}

function shellError(err: unknown): Error {
  if (typeof err === "object" && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (typeof code === "string" && typeof message === "string") {
      return code === "identity_provider_unreachable" ? new IdentityProviderUnavailableError(message) : new Error(message);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

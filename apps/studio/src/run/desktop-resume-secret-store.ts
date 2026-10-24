import { invoke } from "@tauri-apps/api/core";

import type { ResumeSecretStore } from "./runner-credentials";

/**
 * The desktop build's resume secrets live in the OS credential store, through
 * the shell (service `com.telo.studio`, one entry per runner and workspace).
 * The shell names the entry itself from those two parts, so these commands
 * reach resume secrets and nothing else it keeps there.
 */
export function desktopResumeSecretStore(): ResumeSecretStore {
  return {
    async read({ runner, workspaceKey }) {
      try {
        return await invoke<string | null>("runner_resume_secret_read", { runner, workspace: workspaceKey });
      } catch (err) {
        throw shellError(err);
      }
    },
    async write({ runner, workspaceKey }, secret) {
      try {
        await invoke("runner_resume_secret_write", { runner, workspace: workspaceKey, secret });
      } catch (err) {
        throw shellError(err);
      }
    },
  };
}

function shellError(err: unknown): Error {
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return new Error(message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { cloudBackend } from "../cloud/backend";
import { desktopRunnerTokenHolder } from "./desktop-runner-token-holder";
import { indexedDbDpopKeyStore, type DpopKeyStore } from "./dpop-key-store";
import { identityCredentials } from "./identity-credentials";
import type { RunnerCredentials } from "./runner-credentials";
import { RunnerTokenSource, type RunnerTokenHolder } from "./runner-token";
import { webRunnerTokenHolder } from "./web-runner-token-holder";
import type { WorkspaceIdentity } from "./workspace-session";

let keyStore: DpopKeyStore | null = null;

/** The installation's DPoP keys, one per signed-in subject. */
export function pageDpopKeyStore(): DpopKeyStore {
  keyStore ??= indexedDbDpopKeyStore();
  return keyStore;
}

let holder: RunnerTokenHolder | null = null;

/** Whoever holds the sign-in in this build: the web build's same-origin
 *  server, or the desktop shell. */
function pageTokenHolder(): RunnerTokenHolder {
  holder ??= isTauri() ? desktopRunnerTokenHolder() : webRunnerTokenHolder(cloudBackend());
  return holder;
}

function announceReauthorization(resource: string): void {
  toast.info(`Authorizing ${resource} again`, {
    description: "The identity provider no longer honours this runner's sign-in, so Studio asks for it once more.",
    duration: 10_000,
  });
}

/**
 * The signed-in identity as runner sessions use it, for one sign-in: proofs
 * are signed with `subject`'s key on this installation, and each runner's
 * access token is held in memory by its credentials, so a new sign-in —
 * another user — starts from none.
 */
export function pageWorkspaceIdentity(issuer: string, subject: string): WorkspaceIdentity {
  const key = () => pageDpopKeyStore().key(subject);
  const tokens = new RunnerTokenSource(pageTokenHolder(), key, Date.now, announceReauthorization);
  const byResource = new Map<string, RunnerCredentials>();
  return {
    issuer,
    credentials(resource) {
      let credentials = byResource.get(resource);
      if (!credentials) {
        credentials = identityCredentials({ resource, tokens, key });
        byResource.set(resource, credentials);
      }
      return credentials;
    },
  };
}

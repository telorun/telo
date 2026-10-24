import type { ResumeSecretStore } from "./runner-credentials";
import { runnerIdentityEligibility } from "./runner-identity";
import type { RunAdapter } from "./types";
import type { WorkspaceIdentity } from "./workspace-session";
import type { WorkspaceSessionEntry } from "./workspace-session-entry";

export interface AdoptionTarget {
  workspaceKey: string;
  entry: WorkspaceSessionEntry;
  /** The runner the entry names, as the settings configure it. */
  runner: { id: string; adapter: RunAdapter<unknown>; config: unknown };
}

export type AdoptionOutcome =
  /** The identity owns the session now; the secret is deleted. */
  | { workspaceKey: string; kind: "adopted"; sessionId: string }
  /** The identity already held a session for the workspace: the entry names
   *  it, and the secret is forgotten. */
  | { workspaceKey: string; kind: "switched"; sessionId: string }
  /** The secret opened nothing: it and the session id are forgotten. */
  | { workspaceKey: string; kind: "forgotten" }
  /** Nothing to adopt here: no secret, or a runner that does not accept the
   *  identity. */
  | { workspaceKey: string; kind: "skipped" }
  | { workspaceKey: string; kind: "failed"; error: Error };

export interface AdoptionInput {
  targets: AdoptionTarget[];
  secrets: ResumeSecretStore;
  identity: WorkspaceIdentity;
  saveEntry(workspaceKey: string, entry: WorkspaceSessionEntry): void;
}

/**
 * On sign-in: every session this device holds a resume secret for, on a
 * runner that accepts the identity, becomes the identity's
 * (`POST /v1/sessions/:id/owner` with both credentials), and its secret is
 * deleted. Each target is settled on its own; one that fails is reported and
 * keeps its secret.
 */
export async function adoptDeviceSessions(input: AdoptionInput): Promise<AdoptionOutcome[]> {
  return Promise.all(input.targets.map((target) => adoptOne(input, target)));
}

async function adoptOne(input: AdoptionInput, target: AdoptionTarget): Promise<AdoptionOutcome> {
  const { workspaceKey, entry, runner } = target;
  const skipped: AdoptionOutcome = { workspaceKey, kind: "skipped" };
  if (!entry.sessionId || entry.runner !== runner.id || entry.owner === "identity") return skipped;
  const scope = { runner: runner.id, workspaceKey };
  try {
    const secret = await input.secrets.read(scope);
    if (!secret) return skipped;
    // Asked before connecting, so a runner Studio would have to start is not
    // started for a sign-in.
    const capabilities = await runner.adapter.fetchCapabilities?.(runner.config);
    if (!capabilities?.identity) return skipped;
    const connection = await runner.adapter.connect(runner.config);
    const eligibility = runnerIdentityEligibility({
      signedIn: true,
      connectedBaseUrl: connection.baseUrl,
      identity: capabilities.identity,
      issuer: input.identity.issuer,
    });
    if (!eligibility.use) return skipped;

    const answer = await connection.adoptSession(
      entry.sessionId,
      secret,
      input.identity.credentials(eligibility.resource),
    );
    const next: WorkspaceSessionEntry = { ...entry };
    delete next.resumeSecret;
    if (answer.kind === "gone") {
      delete next.sessionId;
      delete next.owner;
    } else {
      next.sessionId = answer.sessionId;
      next.owner = "identity";
    }
    input.saveEntry(workspaceKey, next);
    await input.secrets.write(scope, null);
    if (answer.kind === "gone") return { workspaceKey, kind: "forgotten" };
    return { workspaceKey, kind: answer.kind === "adopted" ? "adopted" : "switched", sessionId: answer.sessionId };
  } catch (err) {
    return { workspaceKey, kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
  }
}

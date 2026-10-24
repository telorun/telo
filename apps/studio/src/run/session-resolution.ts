import { resumeSecretCredentials, type RunnerCredentials } from "./runner-credentials";
import {
  SessionGoneError,
  type CreateSessionRequest,
  type RunnerConnection,
  type RunnerSession,
  type SessionDocument,
} from "./types";

export interface SessionResolutionInput {
  connection: RunnerConnection;
  /** The session this device last held for the workspace on this runner, and
   *  the resume secret it holds for it, if any. */
  stored: { sessionId: string; resumeSecret: string | null } | null;
  /** The signed-in identity's credentials, when this runner is reached with
   *  them; null for a resume secret. */
  identity: RunnerCredentials | null;
  /** What a new session is created with. */
  create: CreateSessionRequest;
  createOptions: { acceptedTermsVersion?: string; withheldConfig?: string[] };
}

export interface ResolvedSession {
  session: RunnerSession;
  document: SessionDocument;
  /** True when this resolution created the session: it is empty and needs
   *  seeding, and holds the app set it was created with. */
  created: boolean;
  /** Who owns the session: the identity, or the resume secret below. */
  owner: "identity" | "secret";
  /** The secret to keep for the next open; null for an identity's session. */
  resumeSecret: string | null;
}

/**
 * Find the workspace's session. With an identity: the stored one — adopted
 * first when this device still holds its resume secret — else the identity's
 * own session for the workspace, else a new one. With a resume secret: the
 * stored one, else a new one. A stored id the runner no longer holds
 * (retention removed it) is a new session, not an error, and a create the
 * runner answers `409 session_exists` is that existing session. Either way a
 * suspended or failed session is resumed.
 */
export async function resolveSession(input: SessionResolutionInput): Promise<ResolvedSession> {
  return input.identity ? resolveForIdentity(input, input.identity) : resolveWithSecret(input);
}

async function resolveForIdentity(input: SessionResolutionInput, identity: RunnerCredentials): Promise<ResolvedSession> {
  const { connection, stored } = input;
  const found = (session: RunnerSession, document: SessionDocument): ResolvedSession => ({
    session,
    document,
    created: false,
    owner: "identity",
    resumeSecret: null,
  });

  let candidate = stored?.sessionId ?? null;
  if (stored?.resumeSecret) {
    const adopted = await connection.adoptSession(stored.sessionId, stored.resumeSecret, identity);
    // `gone`: the secret opens nothing — possibly adopted already, so the id
    // is still asked for under the identity.
    if (adopted.kind !== "gone") candidate = adopted.sessionId;
  }
  if (candidate) {
    const reached = await reach(connection.session(candidate, identity));
    if (reached) return found(reached.session, reached.document);
  }
  const [newest] = await connection.listSessions(input.create.workspace, identity);
  if (newest) {
    const reached = await reach(connection.session(newest.sessionId, identity));
    if (reached) return found(reached.session, reached.document);
  }

  const answer = await connection.createSession(input.create, { ...input.createOptions, credentials: identity });
  const session = connection.session(answer.sessionId, identity);
  const document = await session.read();
  return {
    session,
    document: answer.kind === "exists" ? await resumed(session, document) : document,
    created: answer.kind === "created",
    owner: "identity",
    resumeSecret: null,
  };
}

async function resolveWithSecret(input: SessionResolutionInput): Promise<ResolvedSession> {
  const { connection, stored } = input;
  if (stored?.resumeSecret) {
    const reached = await reach(connection.session(stored.sessionId, resumeSecretCredentials(stored.resumeSecret)));
    if (reached) {
      return { ...reached, created: false, owner: "secret", resumeSecret: stored.resumeSecret };
    }
  }

  const answer = await connection.createSession(input.create, input.createOptions);
  if (answer.kind === "exists") {
    throw new Error(
      `The runner already holds a session for this workspace (${answer.sessionId}), and this device has no credentials for it.`,
    );
  }
  if (!answer.resumeSecret) {
    throw new Error("The runner created the session without answering a resume secret, and this device has no other credentials for it.");
  }
  const session = connection.session(answer.sessionId, resumeSecretCredentials(answer.resumeSecret));
  return { session, document: await session.read(), created: true, owner: "secret", resumeSecret: answer.resumeSecret };
}

/** The session, resumed when suspended or failed; null when the runner holds
 *  no such session for these credentials. */
async function reach(session: RunnerSession): Promise<{ session: RunnerSession; document: SessionDocument } | null> {
  try {
    return { session, document: await resumed(session, await session.read()) };
  } catch (err) {
    if (err instanceof SessionGoneError) return null;
    throw err;
  }
}

/** The session as it is once a suspended or failed one has been asked back. */
async function resumed(session: RunnerSession, document: SessionDocument): Promise<SessionDocument> {
  if (document.status.kind !== "suspended" && document.status.kind !== "failed") return document;
  await session.resume();
  return { ...document, status: { kind: "starting" } };
}
